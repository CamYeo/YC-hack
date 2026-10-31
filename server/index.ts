import { loadHackathonConfig } from "./config/hackathonConfig"
import { ConfigError } from "./config/types"
import { createLiveRelay } from "./providers/relay/liveRelay"
import { createMemoryRelay } from "./providers/relay/memoryRelay"
import { createTerseRoomStore } from "./terse/terseRoomStore"
import { SeminarService } from "./seminar/service"
import { ClientMessageSchema,CreateRoomRequestSchema } from "../shared/contracts"
import { topicsResponse } from "../topics"
import { createLogger } from "./log"
import type { ServerWebSocket } from "bun"
import { join } from "node:path"
import { createSpeechCache, SpeechCacheError } from "./speech/cache"

const logger=createLogger("app")
const config=(()=>{try{const rootIndex=process.argv.indexOf("--repo-root");return loadHackathonConfig(rootIndex>=0?process.argv[rootIndex+1]:undefined)}catch(error){if(error instanceof ConfigError){process.stderr.write(`${error.message}\n`);process.exit(1)}throw error}})()
const relay=config.relay?await createLiveRelay(config.relay,config.repoRoot):createMemoryRelay()
const store=createTerseRoomStore(config.terse)
const speechCache=createSpeechCache({directory:join(config.repoRoot,".local","speech-cache"),generate:async(input,signal)=>{
  if(!service.eleven)throw new SpeechCacheError("AUDIO_INVALID","ElevenLabs is not configured",503)
  return service.eleven.streamSpeech(input.voiceId,input.text,signal)
}})
const service=new SeminarService(config,store,relay,{role:process.argv.includes("--distributed")?"coordinator":"all",prepareSpeech:(speakerId,segments,signal)=>{
  const eleven=service.eleven,voice=config.elevenlabs?.voices[speakerId]
  if(!eleven||!voice)return
  // Only a floor-approved contribution is prepared. Live reasoning and turn choice stay live.
  void(async()=>{for(const text of segments){if(signal.aborted)return;await speechCache.prewarm(eleven.speechRequest(voice,text),{signal})}})().catch(()=>{if(!signal.aborted)logger.debug("Speech preparation deferred to playback")})
}})
await service.start()
type SocketData={roomId:string;token:string}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}})
const problem=(code:string,message:string,status:number)=>json({error:{code,message}},status)
const server=Bun.serve<SocketData>({hostname:config.server.host,port:config.server.port,idleTimeout:60,
  async fetch(request,server){
    const url=new URL(request.url);const origin=request.headers.get("origin")
    if(origin&&!config.server.allowedOrigins.includes(origin))return problem("ORIGIN","This origin is not allowed",403)
    if(request.method==="OPTIONS")return new Response(null,{status:204})
    if(Number(request.headers.get("content-length")??0)>20000)return problem("TOO_LARGE","Request is too large",413)
    try{
      if(url.pathname==="/api/status"&&request.method==="GET")return json(service.providers())
      if(url.pathname==="/api/topics"&&request.method==="GET")return json(topicsResponse())
      if(url.pathname==="/api/rooms"&&request.method==="POST"){
        const input=CreateRoomRequestSchema.safeParse(await request.json());if(!input.success)return problem("INVALID","Check the topic and seminar options",400)
        return json(await service.createRoom(input.data),201)
      }
      if(url.pathname==="/ws"){
        const roomId=url.searchParams.get("roomId")??"",token=url.searchParams.get("roomToken")??""
        if(!service.registry.verify(roomId,token))return problem("UNAUTHORIZED","This room token is invalid",401)
        if(server.upgrade(request,{data:{roomId,token}}))return
        return problem("UPGRADE","A WebSocket connection is required",400)
      }
      const stt=/^\/api\/rooms\/([a-zA-Z0-9_-]+)\/stt-token$/.exec(url.pathname)
      if(stt&&request.method==="POST"){
        const roomId=stt[1]??"";if(!service.registry.verify(roomId,request.headers.get("x-room-token")??""))return problem("UNAUTHORIZED","This room token is invalid",401)
        if(!service.eleven)return problem("VOICE_SETUP","ElevenLabs is not fully configured. You can type your contribution.",503)
        const state=await store.getSnapshot(roomId);if(state.phase!=="discussion")return problem("PAUSED","Resume before enabling the microphone",409)
        return json(await service.eleven.mintScribeToken())
      }
      const tts=/^\/api\/tts\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/(\d+)$/.exec(url.pathname)
      if(tts&&request.method==="GET"){
        const [,roomId="",utteranceId="",segment=""]=tts
        if(!service.registry.verify(roomId,url.searchParams.get("roomToken")??""))return problem("UNAUTHORIZED","This room token is invalid",401)
        const state=await store.getSnapshot(roomId);const epoch=Number(url.searchParams.get("epoch"));const index=Number(segment)
        if(!state.floor||state.floor.utteranceId!==utteranceId||state.floor.generationEpoch!==epoch||state.generationEpoch!==epoch||state.phase!=="discussion"||state.floor.expiresAt<Date.now())return problem("STALE","This speech is no longer current",410)
        const contributionId=state.floor.contributionId
        const contribution=state.contributions.find(c=>c.id===contributionId);const text=contribution?.segments[index]
        if(!text)return problem("SEGMENT","No such speech segment",404)
        if(!service.eleven||!config.elevenlabs)return problem("VOICE_SETUP","ElevenLabs is not configured",503)
        const voice=config.elevenlabs.voices[state.floor.speakerId]
        // Cross-room cache hits still require this room token and the current floor/epoch.
        // A cache miss streams a single MP3 as it arrives, rather than buffering all audio.
        return await speechCache.respond(service.eleven.speechRequest(voice,text),{signal:request.signal,isCurrent:async()=>{
          const current=await store.getSnapshot(roomId)
          return current.phase==="discussion"&&current.generationEpoch===epoch&&current.floor?.utteranceId===utteranceId&&current.floor.generationEpoch===epoch&&current.floor.expiresAt>=Date.now()
        }})
      }
      return problem("NOT_FOUND","Unknown endpoint",404)
    }catch(error){if(error instanceof SpeechCacheError)return problem(error.code,error.message,error.status);logger.warn("Request failed",{path:url.pathname,error:error instanceof Error?error.message:"Unknown error"});return problem("REQUEST_FAILED",error instanceof Error?error.message:"The request failed",500)}
  },
  websocket:{
    async open(ws:ServerWebSocket<SocketData>){try{await service.connect(ws.data.roomId,ws.data.token,ws)}catch(error){await service.fail(ws.data.roomId,error);ws.close(1011,"Room unavailable")}},
    message(ws,message){if(message.toString().length>20000){ws.close(1009,"Message too large");return}try{const parsed=ClientMessageSchema.safeParse(JSON.parse(message.toString()));if(!parsed.success){ws.send(JSON.stringify({type:"notice",level:"error",text:"Invalid room action"}));return}void service.handle(ws.data.roomId,parsed.data).catch(error=>service.fail(ws.data.roomId,error))}catch{ws.send(JSON.stringify({type:"notice",level:"error",text:"Invalid message"}))}},
    close(ws){void service.disconnect(ws.data.roomId,ws).catch(()=>undefined)},
  }
})
logger.info("APPRENTICE backend ready",{url:`http://127.0.0.1:${server.port}`,reasoning:service.reasoner.label,relay:relay.kind,voice:service.eleven?"ElevenLabs":"browser fixture"})
let stopping=false
async function stop(){if(stopping)return;stopping=true;await service.stop();await speechCache.close();await server.stop(true);process.exit(0)}
process.on("SIGINT",()=>{void stop()});process.on("SIGTERM",()=>{void stop()})
