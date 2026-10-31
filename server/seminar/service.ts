import type { RoomStore } from "./roomStore"
import type { HackathonConfig } from "../config/types"
import type { RelayTransport,RelayInboundMessage,DeliveryPumpGroup } from "../providers/relay/types"
import { RelayError } from "../providers/relay/types"
import { createDeliveryPump,createDeliveryPumpGroup } from "../providers/relay/deliveryPump"
import { createOutbox } from "./outbox"
import { createRoomRegistry } from "./roomRegistry"
import { createReasoner,validateDraft } from "../agents/reasoner"
import { withOpeningCache } from "../agents/openingCache"
import { join } from "node:path"
import { createToolRunner } from "../tools/toolRunner"
import { createTopicRegistry,resolveTopic } from "../../topics"
import { createElevenLabsClient } from "../providers/elevenlabs"
import { createLogger } from "../log"
import { RelayEnvelopeSchema,RelayIdentitySchema,speakerNames,splitIntoSegments } from "../../shared/contracts"
import type { ClientMessage,ServerMessage,CreateRoomRequest,CreateRoomResponse,ProviderStatus,RelayEnvelope,RelayIdentity,RelayEventKind,EnvelopeOf,ProposalWire } from "../../shared/contracts"
import type { RoomState,SpeakerId,Contribution,RoomConfig,TraceInput,Reflection, PublicRoomState } from "../../actor/src/roomTypes"
import type { AgentContext, Reasoner } from "../agents/types"

export interface RoomSocket { send(data:string):unknown;close(code?:number,reason?:string):void }
type Connected={socket:RoomSocket;token:string}
export type ServiceRole = "all" | "coordinator" | SpeakerId | "evidence"
export interface ServiceOptions {
  role?: ServiceRole
  reasoner?: Reasoner
  /** Best-effort audio warming for the approved utterance only; never delays playback. */
  prepareSpeech?: (speakerId:SpeakerId,segments:string[],signal:AbortSignal)=>void
}
export class SeminarService {
  readonly registry:ReturnType<typeof createRoomRegistry>
  readonly eleven:ReturnType<typeof createElevenLabsClient>|null
  readonly topics=createTopicRegistry()
  readonly reasoner:Reasoner
  readonly tools=createToolRunner()
  readonly pumps:DeliveryPumpGroup=createDeliveryPumpGroup()
  readonly outbox:ReturnType<typeof createOutbox>
  readonly sockets=new Map<string,Connected>()
  readonly logger=createLogger("seminar")
  private readonly inflight=new Map<string,{roomId:string;epoch:number;abort:AbortController}>()
  private readonly notes=new Map<string,string[]>()
  private readonly collections=new Map<string,ReturnType<typeof setTimeout>>()
  private readonly queues=new Map<string,Promise<unknown>>()
  private readonly hiddenTimers=new Map<string,ReturnType<typeof setTimeout>>()
  private readonly actorSubscriptions=new Map<string,()=>void>()
  private readonly observed=new Map<string,{epoch:number;phase:string;signature:string;version:number;trace:number;updatedAt:number}>()
  private readonly collectionStarted=new Map<string,{at:number;epoch:number;version:number}>()
  private tickTimer:ReturnType<typeof setInterval>|null=null
  private ticking=false
  private pumpCadence:"active"|"idle"|"paused"|null=null
  private relayError:string|null=null
  private voiceError:string|null=null
  private modelError:string|null=null
  constructor(readonly config:HackathonConfig,readonly store:RoomStore,readonly relay:RelayTransport,readonly options:ServiceOptions={}){
    this.registry=createRoomRegistry(config.repoRoot)
    const reasoner=options.reasoner??createReasoner(config.openai)
    this.reasoner=config.cacheOpening&&config.openai?withOpeningCache(reasoner,{directory:join(config.repoRoot,".local","opening-cache"),model:config.openai.model,reasoningEffort:config.openai.reasoningEffort}):reasoner
    this.eleven=config.elevenlabs?createElevenLabsClient(config.elevenlabs):null
    this.outbox=createOutbox(relay,store,this.pumps)
  }
  providers():ProviderStatus {
    const provider=(live:boolean,label:string,missing:string[]=[],lastError:string|null=null)=>({mode:live?"live" as const:"fixture" as const,label,missing,lastError})
    return {appMode:this.config.appMode,reasoning:provider(!!this.config.openai,this.reasoner.label,this.config.missing.openai,this.modelError),voice:provider(!!this.eleven,this.eleven?"ElevenLabs · three character voices":"Browser speech · fixture",this.config.missing.elevenlabs,this.voiceError),transcription:provider(!!this.eleven,this.eleven?"ElevenLabs Scribe":"Text input · voice unavailable",this.config.missing.elevenlabs),relay:{...provider(this.relay.kind==="live",this.relay.kind==="live"?"Agent Relay · live delivery":"In-memory Relay fixture · not Agent Relay",this.config.missing.relay,this.relayError),workspaceId:this.relay.workspaceId,deliveryMode:this.relay.deliveryStatus?.().mode??(this.relay.kind==="live"?"polling":"memory"),deliveryState:this.relay.deliveryStatus?.().state,deliveryReason:this.relay.deliveryStatus?.().reason,measuredDeliveryP50Ms:this.pumps.measuredDelayP50Ms()},terse:{mode:"live",label:"Terse · local durable actors",missing:[],lastError:null,actorUrl:this.config.terse.actorUrl}}
  }
  private send(roomId:string,message:ServerMessage){this.sockets.get(roomId)?.socket.send(JSON.stringify(message))}
  async broadcast(roomId:string){const s=await this.store.getSnapshot(roomId);const {processedEventKeys:_,pendingOutbound:__,...state}=s;await this.observeActor(state);return s}
  private async trace(roomId:string,input:TraceInput){await this.store.appendTrace(roomId,[input])}
  private event<K extends RelayEventKind>(s:RoomState,actorId:RelayIdentity,kind:K,payload:EnvelopeOf<K>["payload"],text:string,eventId:string=crypto.randomUUID()):RelayEnvelope {
    return RelayEnvelopeSchema.parse({v:1,eventId,roomId:s.roomId,sessionId:s.sessionId,actorId,kind,replyTo:s.contributions.at(-1)?.id??null,roomVersion:s.version,generationEpoch:s.generationEpoch,utteranceId:s.floor?.utteranceId??null,text,payload})
  }
  private async post(s:RoomState,sender:RelayIdentity,envelope:RelayEnvelope,to?:RelayIdentity){
    if(!s.config)throw new Error("Room has no topic")
    return this.outbox.send({roomId:s.roomId,sender,target:to?{type:"dm",to}:{type:"channel",channel:s.config.relayChannel},text:envelope.text,envelope})
  }
  private serial<T>(roomId:string,task:()=>Promise<T>):Promise<T>{
    const previous=this.queues.get(roomId)??Promise.resolve();const next=previous.catch(()=>undefined).then(task)
    this.queues.set(roomId,next);void next.finally(()=>{if(this.queues.get(roomId)===next)this.queues.delete(roomId)}).catch(()=>undefined)
    return next
  }
  async start(){
    const role=this.options.role??"all"
    for(const id of (role==="all"||role==="coordinator")?this.registry.ids():[]){
      try{const recovered=await this.store.recoverAfterRestart(id);if(this.relay.kind==="memory"){const state=await this.store.getSnapshot(id);const recoveredConfig=state.config;if(recoveredConfig){await this.relay.ensureChannel(recoveredConfig.relayChannel,recoveredConfig.topicTitle);await Promise.all(RelayIdentitySchema.options.map(identity=>this.relay.agent(identity).joinChannel(recoveredConfig.relayChannel)))}}if(recovered.recovered)await this.trace(id,{channel:"terse",direction:"local",kind:"recovery.restored",from:"SeminarActor",to:"bridge",relayMessageId:null,eventId:null,summary:`Restored delivered transcript; stale speech revoked at epoch ${recovered.generationEpoch}. Explicit resume required.`,latencyMs:null});await this.outbox.flushPending(id)}catch{this.logger.warn("Room recovery needs attention",{roomId:id})}
    }
    const identities:RelayIdentity[]=role==="all"?["facilitator","maya","theo","evidence","bridge"]:role==="coordinator"?["bridge"]:[role]
    for(const identity of identities){
      const pump=createDeliveryPump({client:this.relay.agent(identity),group:this.pumps,handler:message=>this.consume(identity,message),onError:()=>{void this.relayFailed().catch(()=>undefined)},timing:this.relay.kind==="memory"?{active:15,idle:30,paused:100,boosted:5,boostDuration:1000}:undefined});pump.start()
    }
    // Separate workers have no browser hello. They must keep discovering new rooms, then
    // follow actor phase changes; otherwise they remain on the five-second paused poll.
    this.setPumpCadence(role==="all"||role==="coordinator"?"paused":"idle")
    if(role==="all"||role==="coordinator")this.tickTimer=setInterval(()=>{void this.tick()},1500)
  }
  async stop(){for(const unsubscribe of this.actorSubscriptions.values())unsubscribe();this.actorSubscriptions.clear();if(this.tickTimer)clearInterval(this.tickTimer);for(const timer of [...this.collections.values(),...this.hiddenTimers.values()])clearTimeout(timer);for(const work of this.inflight.values())work.abort.abort();for(const id of this.sockets.keys())await this.store.pauseSession(id,"server-stopped").catch(()=>undefined);await this.pumps.stopAll()}
  async createRoom(input:CreateRoomRequest):Promise<CreateRoomResponse>{
    const topic=input.topicId==="custom"?this.topics.custom(input.customQuestion||"What is worth understanding more deeply?",input.reading):this.topics.get(input.topicId)
    if(!topic)throw new Error("Choose an available topic")
    if(input.topicId==="custom"&&!input.customQuestion?.trim())throw new Error("Enter a question for your custom seminar")
    const roomId=`r-${Date.now().toString(36)}-${crypto.randomUUID().slice(0,8)}`;const sessionId=crypto.randomUUID()
    const channel=`sem-${roomId}`
    await this.relay.ensureChannel(channel,topic.title)
    await Promise.all(RelayIdentitySchema.options.map(id=>this.relay.agent(id).joinChannel(channel)))
    const config:RoomConfig={topicId:topic.id,topicTitle:topic.title,category:topic.category,format:"socratic",theme:input.theme??"classroom",difficulty:input.difficulty,participation:input.participation,openingQuestion:topic.openingQuestion,customQuestion:input.customQuestion,reading:input.reading,sessionMinutes:15,maxAiTurns:40,maxGenerationCalls:100,aiTurnsBeforeInvite:input.participation==="observe"?5:input.participation==="lead"?1:2,relayChannel:channel}
    await this.store.startSession(roomId,{roomId,sessionId,config})
    const roomToken=this.registry.create(roomId,channel)
    return {roomId,sessionId,roomToken}
  }
  async connect(roomId:string,token:string,socket:RoomSocket){
    const previous=this.sockets.get(roomId);this.sockets.set(roomId,{socket,token});previous?.socket.close(4000,"Opened in another tab")
    await this.watchActor(roomId)
    const s=await this.broadcast(roomId);this.send(roomId,{type:"welcome",roomId,sessionId:s.sessionId,providers:this.providers()})
  }
  async disconnect(roomId:string,socket:RoomSocket){if(this.sockets.get(roomId)?.socket!==socket)return;this.sockets.delete(roomId);this.actorSubscriptions.get(roomId)?.();this.actorSubscriptions.delete(roomId);this.observed.delete(roomId);this.abort(roomId);await this.store.pauseSession(roomId,"disconnected");if(!this.sockets.size)this.setPumpCadence("paused")}
  private abort(roomId:string){for(const [key,work] of this.inflight){if(work.roomId===roomId){work.abort.abort();this.inflight.delete(key)}}const timer=this.collections.get(roomId);if(timer)clearTimeout(timer);this.collections.delete(roomId);this.collectionStarted.delete(roomId)}
  async handle(roomId:string,m:ClientMessage){return this.serial(roomId,async()=>{
    let s=await this.store.getSnapshot(roomId)
    if(m.type==="hello"){
      if(m.resume){await this.pause(roomId,"reconnected");return}
      this.setPumpCadence("active")
      if(!s.processedEventKeys.includes("bridge:kickoff")){
        if(!s.config)return
        await this.post(s,"bridge",this.event(s,"bridge","session.started",{topicId:s.config.topicId,topicTitle:s.config.topicTitle,format:s.config.format,participation:s.config.participation,difficulty:s.config.difficulty,openingQuestion:s.config.openingQuestion,hint:s.turn.hint},"The seminar begins.",`kickoff-${s.sessionId}`))
        await this.store.markEventProcessed(roomId,"bridge","kickoff")
      }
    } else if(m.type==="human.jumpIn"){
      this.abort(roomId);const result=await this.store.interrupt(roomId,m.source==="voice-onset"?"voice-onset":"human-jump-in");s=await this.broadcast(roomId);this.send(roomId,{type:"stop",generationEpoch:s.generationEpoch,reason:"Your turn"});await this.post(s,"bridge",this.event(s,"bridge","floor.revoked",{reason:"human-jump-in",newEpoch:s.generationEpoch},"The human has the floor."));if(result.interrupted?.heardText)await this.publishHeard(s,result.interrupted)
    } else if(m.type==="human.contribution"||m.type==="human.correction"){
      this.abort(roomId)
      const result=await this.store.appendHumanContribution(roomId,{eventId:m.eventId,text:m.text,inputMode:m.type==="human.contribution"?m.inputMode:"text",replyToContributionId:m.type==="human.contribution"?m.replyToContributionId:null,addressedTo:m.type==="human.contribution"?m.addressedTo:"group",correctionOf:m.type==="human.correction"?m.contributionId:null})
      if(!result.ok){if(result.reason!=="duplicate")throw new Error(`Contribution not accepted: ${result.reason}`);return}
      s=await this.broadcast(roomId);this.send(roomId,{type:"stop",generationEpoch:s.generationEpoch,reason:"Human contribution"})
      if(result.interrupted?.heardText)await this.publishHeard(s,result.interrupted)
      const c=result.contribution
      const envelope=this.event(s,"learner","human.contributed",{contributionId:c.id,speakerId:"human",addressedTo:c.addressedTo,replyToContributionId:c.replyToContributionId,heardText:c.heardText,interrupted:false,sourceIds:[],inputMode:c.inputMode==="voice"?"voice":"text",correctionOf:c.correctionOf,hint:s.turn.hint},`You: ${c.heardText}`,c.eventId)
      const post=await this.post(s,"learner",envelope);await this.store.setContributionRelayMessageId(roomId,c.id,post.messageId)
    } else if(m.type==="playback.segment"){
      if(m.event==="ended")await this.store.markSegmentHeard(roomId,{utteranceId:m.utteranceId,segmentIndex:m.segmentIndex,leaseMs:45000})
    } else if(m.type==="playback.finished"){
      const pending=s.pendingProposals.find(p=>p.proposalId===s.floor?.proposalId)
      const result=await this.store.finishUtterance(roomId,{utteranceId:m.utteranceId,outcome:m.outcome})
      if(!result.ok)return
      this.finishSpeechPreparation(roomId,m.utteranceId)
      if(m.outcome==="failed"){this.voiceError="Voice playback failed. You can continue with captions.";this.send(roomId,{type:"notice",level:"warning",text:this.voiceError})}
      s=await this.broadcast(roomId)
      if(result.contribution.heardText)await this.publishHeard(s,result.contribution)
      else if(m.outcome==="failed"){await this.pause(roomId,"audio-failed");this.send(roomId,{type:"notice",level:"warning",text:"Playback failed. Turn voice off for captions, then resume."})}
      if(pending?.evidenceRequest&&m.outcome==="completed")await this.requestEvidence(s,result.contribution.speakerId as SpeakerId,pending.evidenceRequest.toolId,pending.evidenceRequest.caseId,pending.evidenceRequest.question)
    } else if(m.type==="session.pause"){await this.pause(roomId,"user-paused")}
    else if(m.type==="session.resume"){
      await this.outbox.flushPending(roomId);this.relayError=null;this.modelError=null;await this.store.resumeSession(roomId);s=await this.broadcast(roomId);this.setPumpCadence("active");await this.post(s,"bridge",this.event(s,"bridge","session.resumed",{hint:s.turn.hint},"The seminar resumes."))
    } else if(m.type==="session.theme"){
      if((s.config?.theme??"classroom")===m.theme)return
      // A presentation change must not cancel the session's final reflection.
      if(s.phase==="discussion")this.abort(roomId)
      const result=await this.store.setTheme(roomId,m.theme)
      s=await this.broadcast(roomId)
      this.send(roomId,{type:"stop",generationEpoch:s.generationEpoch,reason:"Seminar theme changed"})
      this.send(roomId,{type:"thinking",speakerIds:[]})
      if(result.interrupted?.heardText)await this.publishHeard(s,result.interrupted)
      if(s.phase==="discussion"&&!s.turn.awaitingHuman){
        await this.post(s,"bridge",this.event(s,"bridge","floor.opened",{reason:"resume",hint:s.turn.hint},"The seminar theme changed. Continue with the current participant names and the same topic."))
      }
    } else if(m.type==="human.pass"){
      if(s.phase!=="discussion"||s.floor)return
      this.abort(roomId);await this.store.openFloor(roomId,"human-pass");s=await this.broadcast(roomId);await this.post(s,"bridge",this.event(s,"bridge","floor.opened",{reason:"human-pass",hint:s.turn.hint},"Please continue the discussion."))
    } else if(m.type==="session.end"){
      if(s.phase==="reflection"||s.phase==="ended")return
      this.abort(roomId);await this.store.beginReflection(roomId,"user-ended");s=await this.broadcast(roomId);this.send(roomId,{type:"stop",generationEpoch:s.generationEpoch,reason:"Session ended"});try{await this.post(s,"bridge",this.event(s,"bridge","session.ended",{reason:"user-ended"},"The seminar has ended."))}finally{void this.reflect(s)}
    } else if(m.type==="evidence.request"){
      if(s.phase!=="discussion")throw new Error("Resume the seminar before requesting evidence")
      await this.requestEvidence(s,"learner",m.toolId,m.caseId,"Investigate this case.")
    } else if(m.type==="board.edit"){const result=await this.store.editBoardCard(roomId,m);if(!result.ok)throw new Error("That reasoning card is no longer available");await this.reopenChangedFloor(roomId)}
    else if(m.type==="board.addHumanCard"){const result=await this.store.addHumanCard(roomId,m);if(!result.ok)throw new Error("Choose one of your completed contributions");await this.reopenChangedFloor(roomId)}
    else if(m.type==="metric"){this.send(roomId,{type:"metric",name:m.name,ms:m.ms,at:Date.now()})}
    else if(m.type==="client.visibility"){
      const old=this.hiddenTimers.get(roomId);if(old)clearTimeout(old);this.hiddenTimers.delete(roomId)
      if(m.hidden)this.hiddenTimers.set(roomId,setTimeout(()=>{void this.serial(roomId,()=>this.pause(roomId,"tab-hidden")).catch(()=>undefined)},10000))
    }
    await this.broadcast(roomId)
  })}
  private async pause(roomId:string,reason:string){
    this.abort(roomId);const result=await this.store.pauseSession(roomId,reason);const s=await this.broadcast(roomId);this.send(roomId,{type:"stop",generationEpoch:s.generationEpoch,reason})
    if(result.interrupted?.heardText)await this.publishHeard(s,result.interrupted)
    if(reason!=="relay-failure")await this.post(s,"bridge",this.event(s,"bridge","session.paused",{reason},"The seminar is paused."))
  }
  private async publishHeard(s:RoomState,c:Contribution){
    if(!["facilitator","maya","theo"].includes(c.speakerId)||!c.heardText)return
    const sender=c.speakerId as SpeakerId
    const post=await this.post(s,sender,this.event(s,sender,"contribution.heard",{contributionId:c.id,speakerId:sender,addressedTo:c.addressedTo,replyToContributionId:c.replyToContributionId,heardText:c.heardText,interrupted:c.status==="interrupted",sourceIds:c.sourceIds,hint:c.status==="interrupted"?{...s.turn.hint,mode:"await-human",preferredSpeakers:[]}:s.turn.hint},`${speakerNames(s.config?.theme)[sender]}: ${c.heardText}`,`heard-${c.id}-${s.sessionId}`))
    await this.store.setContributionRelayMessageId(s.roomId,c.id,post.messageId)
  }
  private async reopenChangedFloor(roomId:string){
    const current=await this.store.getSnapshot(roomId)
    if(current.phase!=="discussion"||current.floor||current.turn.awaitingHuman)return
    this.abort(roomId);await this.store.openFloor(roomId,"resume");const s=await this.store.getSnapshot(roomId)
    await this.post(s,"bridge",this.event(s,"bridge","floor.opened",{reason:"resume",hint:s.turn.hint},"The reasoning board was updated. Consider the corrected context."))
  }
  private async requestEvidence(s:RoomState,sender:SpeakerId|"learner",toolId:string,caseId:string|null,question:string){
    if(!s.config)return;const topic=resolveTopic(this.topics,s.config);const tool=topic.tools.find(t=>t.id===toolId)
    if(!tool||(caseId&&!tool.cases.some(c=>c.id===caseId)))throw new Error("Choose an available experiment")
    const requestId=crypto.randomUUID();const requestedBy=sender==="learner"?"human":sender
    await this.store.recordEvidenceRequest(s.roomId,{requestId,requestedBy,toolId,caseId,question,requestRelayMessageId:null})
    await this.post(s,sender,this.event(s,sender,"evidence.requested",{requestId,requestedBy,toolId,caseId,question},`Evidence requested: ${tool.label}`,`evidence-${requestId}`),"evidence")
  }
  private async consume(identity:RelayIdentity,message:RelayInboundMessage):Promise<"ack"|"retry">{
    const parsed=RelayEnvelopeSchema.safeParse(message.metadata);if(!parsed.success)return "ack"
    const event=parsed.data
    this.registry.refresh()
    if(message.senderName!==event.actorId||!this.registry.has(event.roomId))return "ack"
    await this.watchActor(event.roomId)
    const s=await this.store.getSnapshot(event.roomId)
    if(s.sessionId!==event.sessionId||s.processedEventKeys.includes(`${identity}:${event.eventId}`))return "ack"
    const {processedEventKeys:_,pendingOutbound:__,...publicState}=s
    await this.observeActor(publicState)
    await this.trace(s.roomId,{channel:"relay",direction:"in",kind:event.kind,from:message.senderName,to:identity,relayMessageId:message.messageId,eventId:event.eventId,summary:event.text.slice(0,180),latencyMs:message.deliveryDelayMs})
    try{
      if(identity==="bridge")await this.serial(s.roomId,()=>this.bridge(event,message))
      else if(identity==="evidence")await this.evidence(event)
      else if(identity!=="learner")await this.speaking(identity,event)
      await this.store.markEventProcessed(s.roomId,identity,event.eventId);await this.broadcast(s.roomId);return "ack"
    } catch(error){
      this.logger.warn("Delivery processing failed",{identity,kind:event.kind,error:error instanceof Error?error.message:"Unknown failure"})
      if(error instanceof Error&&error.name==="AbortError")return "ack"
      this.send(s.roomId,{type:"notice",level:"error",text:"A participant could not complete their turn. The room is paused; resume to retry."})
      if(error instanceof RelayError)this.relayError="Agent delivery failed. Resume to retry."
      this.abort(s.roomId);await this.store.pauseSession(s.roomId,"provider-failure");const paused=await this.broadcast(s.roomId);this.send(s.roomId,{type:"stop",generationEpoch:paused.generationEpoch,reason:"Participant unavailable"});this.send(s.roomId,{type:"thinking",speakerIds:[]});return "retry"
    }
  }
  private async speaking(id:SpeakerId,event:RelayEnvelope){
    if(!["session.started","floor.opened","session.resumed","human.contributed","contribution.heard"].includes(event.kind))return
    if(!("hint" in event.payload))return
    const hint=event.payload.hint
    if(!hint.preferredSpeakers.includes(id)||["closed","await-human"].includes(hint.mode))return
    const s=await this.store.getSnapshot(event.roomId)
    if(!s.config||s.phase!=="discussion"||s.generationEpoch!==event.generationEpoch||s.version!==event.roomVersion||s.floor||s.turn.awaitingHuman)return
    if(s.budget.generationCalls>=s.budget.maxGenerationCalls)return
    const key=`${s.roomId}:${id}:${event.eventId}`;if(this.inflight.has(key))return
    const abort=new AbortController();this.inflight.set(key,{roomId:s.roomId,epoch:s.generationEpoch,abort})
    this.send(s.roomId,{type:"thinking",speakerIds:hint.preferredSpeakers})
    await this.trace(s.roomId,{channel:"system",direction:"local",kind:"worker.thinking",from:id,to:"bridge",relayMessageId:null,eventId:event.eventId,summary:`${id} reasoning in process ${process.pid}`,latencyMs:null})
    try{
      const notesKey=`${s.sessionId}:${id}`
      const ctx:AgentContext={agentId:id,roomId:s.roomId,sessionId:s.sessionId,config:s.config,topic:resolveTopic(this.topics,s.config),transcript:s.contributions.filter(c=>["heard","interrupted","human"].includes(c.status)&&c.heardText).slice(-24).map(({id,speakerId,addressedTo,replyToContributionId,heardText,status,sourceIds})=>({id,speakerId,addressedTo,replyToContributionId,heardText,status,sourceIds})),board:s.board.filter(c=>c.status!=="dismissed").map(({id,kind,text,authorId,status,relations})=>({id,kind,text,authorId,status,relations})),evidence:s.evidence,hint,trigger:event,privateNotes:this.notes.get(notesKey)??[],roomVersion:s.version,generationEpoch:s.generationEpoch}
      const {draft:rawDraft,latencyMs,cacheHit}=await this.reasoner.propose(ctx,abort.signal)
      const draft=this.reasoner.mode==="external"?validateDraft(rawDraft,ctx):rawDraft
      if(abort.signal.aborted)return
      const now=await this.store.getSnapshot(s.roomId);if(now.generationEpoch!==s.generationEpoch||now.version!==s.version||now.phase!=="discussion")return
      this.notes.set(notesKey,[...(this.notes.get(notesKey)??[]),draft.privateNote].slice(-5))
      const {privateNote:_,...proposalDraft}=draft
      const proposal:ProposalWire={...proposalDraft,proposalId:`proposal-${id}-${event.eventId}`,speakerId:id,basedOnRoomVersion:s.version,generationEpoch:s.generationEpoch,reasoning:this.reasoner.mode,latencyMs}
      await this.trace(s.roomId,{channel:"openai",direction:"local",kind:"proposal.ready",from:id,to:"bridge",relayMessageId:null,eventId:event.eventId,summary:this.reasoner.label,latencyMs})
      if(cacheHit)await this.trace(s.roomId,{channel:"system",direction:"local",kind:"opening.cache-hit",from:id,to:"bridge",relayMessageId:null,eventId:event.eventId,summary:"Reused a previously OpenAI-generated turn in the untouched SWE opening exchange. Replies after the introduction or any human input are generated live.",latencyMs})
      await this.post(now,id,this.event(now,id,"floor.requested",{proposal},`${speakerNames(now.config?.theme)[id]} requests a turn.`,`proposal-event-${id}-${event.eventId}`),"bridge")
    }catch(error){if(abort.signal.aborted)return;if(!(error instanceof RelayError))this.modelError=error instanceof Error?error.message:"Reasoning unavailable";throw error}
    finally{if(this.inflight.get(key)?.abort===abort)this.inflight.delete(key)}
  }
  private async bridge(event:RelayEnvelope,message:RelayInboundMessage){
    let s=await this.store.getSnapshot(event.roomId)
    if(event.kind==="floor.requested"){
      const p=event.payload.proposal
      if(message.senderName!==p.speakerId)return
      const result=await this.store.submitProposal(s.roomId,{...p,eventId:event.eventId,sessionId:event.sessionId,relayMessageId:message.messageId})
      if(!result.ok){
        if(result.reason!=="duplicate")return
        s=await this.store.getSnapshot(s.roomId)
        if(!s.pendingProposals.some(item=>item.proposalId===p.proposalId)||s.floor)return
      }
      const round=this.collectionStarted.get(s.roomId)
      if(!round||round.epoch!==s.generationEpoch||round.version!==s.version)this.collectionStarted.set(s.roomId,{at:Date.now(),epoch:s.generationEpoch,version:s.version})
      const replied=new Set([...s.pendingProposals,p].filter(item=>item.basedOnRoomVersion===s.version&&item.generationEpoch===s.generationEpoch).map(item=>item.speakerId))
      if(s.turn.hint.preferredSpeakers.every(id=>replied.has(id))){
        const timer=this.collections.get(s.roomId);if(timer)clearTimeout(timer);this.collections.delete(s.roomId)
        await this.chooseFloor(s.roomId)
        return
      }
      if(!this.collections.has(s.roomId))this.collections.set(s.roomId,setTimeout(()=>{this.collections.delete(s.roomId);void this.serial(s.roomId,()=>this.chooseFloor(s.roomId)).catch(error=>this.fail(s.roomId,error))},this.reasoner.mode==="fixture"?120:350))
    }else if(event.kind==="evidence.returned"){
      if(message.senderName!=="evidence")return
      const result=await this.store.recordEvidenceResult(s.roomId,{...event.payload,resultRelayMessageId:message.messageId})
      if(!result.ok&&result.reason!=="duplicate")return
      s=await this.store.getSnapshot(s.roomId)
      const floorEventId=`evidence-floor-${event.payload.requestId}-${s.sessionId}`
      const pending=s.pendingOutbound.find(item=>item.eventId===floorEventId)
      if(pending){await this.post(s,"bridge",RelayEnvelopeSchema.parse(JSON.parse(pending.envelopeJson)));return}
      if(s.processedEventKeys.includes(`outbound:${floorEventId}`))return
      const record=s.evidence.find(item=>item.id===event.payload.requestId)
      if(!s.floor&&s.phase==="discussion"&&!s.turn.awaitingHuman&&record&&!record.discussed){
        this.abort(s.roomId);await this.store.openFloor(s.roomId,"evidence-returned");s=await this.store.getSnapshot(s.roomId)
        await this.post(s,"bridge",this.event(s,"bridge","floor.opened",{reason:"evidence-returned",hint:s.turn.hint},"New evidence is available for discussion.",floorEventId))
      }
    }
  }
  private async chooseFloor(roomId:string){
    const s=await this.store.getSnapshot(roomId)
    if(s.phase!=="discussion"||s.floor||s.turn.awaitingHuman)return
    if(!this.sockets.has(roomId)){await this.store.pauseSession(roomId,"no-listener");return}
    const proposals=s.pendingProposals.filter(p=>p.basedOnRoomVersion===s.version&&p.generationEpoch===s.generationEpoch)
    const recent=s.contributions.filter(c=>c.status==="heard"&&c.speakerId!=="human").slice(-4)
    const tokens=(text:string)=>new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[])
    const repeats=(text:string)=>{const a=tokens(text);return recent.some(c=>{const b=tokens(c.heardText);const union=new Set([...a,...b]).size;return union>0&&[...a].filter(word=>b.has(word)).length/union>=.7})}
    const candidates=proposals.filter(p=>p.action!=="yield"&&!repeats(p.text)&&(!s.turn.hint.requiredAddressee||p.addressedTo===s.turn.hint.requiredAddressee))
    candidates.sort((a,b)=>this.score(s,b.speakerId)-this.score(s,a.speakerId))
    const winner=candidates[0]
    if(!winner){
      // A quick yield must not cancel a second peer whose reasoner is still running.
      const missingPeer=s.turn.hint.preferredSpeakers.some(id=>!proposals.some(p=>p.speakerId===id))
      if(missingPeer&&([...this.inflight.values()].some(work=>work.roomId===roomId&&work.epoch===s.generationEpoch)||(this.options.role==="coordinator"&&Date.now()-(this.collectionStarted.get(roomId)?.at??0)<45000))){
        if(!this.collections.has(roomId))this.collections.set(roomId,setTimeout(()=>{this.collections.delete(roomId);void this.serial(roomId,()=>this.chooseFloor(roomId)).catch(error=>this.fail(roomId,error))},500))
        return
      }
      if(proposals.length){await this.store.interrupt(roomId,"human-jump-in");const next=await this.broadcast(roomId);this.send(roomId,{type:"stop",generationEpoch:next.generationEpoch,reason:"The table is yours"});this.send(roomId,{type:"thinking",speakerIds:[]});this.send(roomId,{type:"notice",level:"info",text:"The table is yours. Add a thought or choose Keep going."})}return
    }
    const result=await this.store.claimFloor(roomId,{proposalId:winner.proposalId,utteranceId:crypto.randomUUID(),segments:splitIntoSegments(winner.text),leaseMs:45000})
    if(!result.ok)return
    this.collectionStarted.delete(roomId)
    if(this.options.prepareSpeech&&this.sockets.has(roomId)){
      const abort=new AbortController()
      this.inflight.set(`speech:${roomId}:${result.lease.utteranceId}`,{roomId,epoch:result.lease.generationEpoch,abort})
      try{this.options.prepareSpeech(winner.speakerId,result.contribution.segments,abort.signal)}
      catch{this.finishSpeechPreparation(roomId,result.lease.utteranceId)}
    }
    await this.trace(roomId,{channel:"terse",direction:"local",kind:"floor.granted",from:"SeminarActor",to:winner.speakerId,relayMessageId:winner.relayMessageId,eventId:winner.eventId,summary:`Exclusive floor · epoch ${result.lease.generationEpoch}`,latencyMs:null})
    await this.broadcast(roomId);this.send(roomId,{type:"thinking",speakerIds:[]})
    // The browser can disconnect while the actor calls above are in flight.
    const connected=this.sockets.get(roomId)
    if(!connected){await this.store.pauseSession(roomId,"no-listener");return}
    const token=connected.token
    this.send(roomId,{type:"speak",utteranceId:result.lease.utteranceId,contributionId:result.contribution.id,speakerId:winner.speakerId,generationEpoch:result.lease.generationEpoch,segments:result.contribution.segments,voice:this.eleven?{mode:"elevenlabs",segmentUrls:result.contribution.segments.map((_,i)=>`/api/tts/${roomId}/${result.lease.utteranceId}/${i}?epoch=${result.lease.generationEpoch}&roomToken=${encodeURIComponent(token)}`)}:{mode:"browser",voiceHint:{speakerId:winner.speakerId,pitch:winner.speakerId==="maya"?.75:winner.speakerId==="facilitator"?1.1:.9,rate:.98}}})
  }
  private score(s:RoomState,id:SpeakerId){return (s.turn.hint.preferredSpeakers[0]===id?100:60)-(s.turn.lastSpeakerId===id?50:0)-s.turn.speakerCounts[id]*5}
  private finishSpeechPreparation(roomId:string,utteranceId:string){
    const key=`speech:${roomId}:${utteranceId}`;this.inflight.get(key)?.abort.abort();this.inflight.delete(key)
  }
  private setPumpCadence(cadence:"active"|"idle"|"paused"){
    // Reapplying cadence reschedules the next poll; frequent actor traces must not postpone it.
    if(this.pumpCadence===cadence)return
    this.pumpCadence=cadence;this.pumps.setCadenceAll(cadence)
  }
  private async evidence(event:RelayEnvelope){
    if(event.kind!=="evidence.requested")return
    const s=await this.store.getSnapshot(event.roomId);if(!s.config)return
    const record=s.evidence.find(e=>e.id===event.payload.requestId);if(!record||record.status!=="pending")return
    const resultEventId=`result-${event.payload.requestId}`
    if(s.processedEventKeys.includes(`outbound:${resultEventId}`))return
    const pending=s.pendingOutbound.find(item=>item.eventId===resultEventId)
    if(pending){await this.post(s,"evidence",RelayEnvelopeSchema.parse(JSON.parse(pending.envelopeJson)));return}
    const outcome=this.tools.run({topic:resolveTopic(this.topics,s.config),toolId:event.payload.toolId,caseId:event.payload.caseId,question:event.payload.question})
    const result=outcome.status==="returned"?outcome.result:null;const error=outcome.status==="failed"?outcome.error:null
    await this.post(s,"evidence",this.event(s,"evidence","evidence.returned",{...event.payload,status:outcome.status,result,error},result?`${result.title}: ${result.observations.join(" ")}`:error??"Evidence unavailable",resultEventId))
  }
  private async reflect(s:RoomState){
    if(!s.config)return;const key=`reflection-${s.roomId}`;if(this.inflight.has(key))return;const abort=new AbortController();this.inflight.set(key,{roomId:s.roomId,epoch:s.generationEpoch,abort})
    const input={config:s.config,topic:resolveTopic(this.topics,s.config),transcript:s.contributions.filter(c=>["human","heard","interrupted"].includes(c.status)&&c.heardText),board:s.board,evidence:s.evidence}
    try{const {draft}=await this.reasoner.reflect(input,abort.signal);if(abort.signal.aborted)return;const current=await this.store.getSnapshot(s.roomId);if(current.generationEpoch!==s.generationEpoch||current.phase!=="reflection")return;const reflection:Reflection={...draft,generatedBy:this.reasoner.mode==="external"?"fixture":this.reasoner.mode,createdAt:Date.now()};await this.store.setReflection(s.roomId,reflection)}
    catch{if(abort.signal.aborted)return;const reflection:Reflection={initialPosition:null,challenge:null,revisedPosition:null,usefulQuestion:null,revisedAssumption:null,unresolved:null,nextQuestion:input.topic.reflectionPrompts[0]??"Which assumption would you test next?",contributionImpact:null,generatedBy:"fixture",createdAt:Date.now()};await this.store.setReflection(s.roomId,reflection);this.send(s.roomId,{type:"notice",level:"warning",text:"Reflection generation was unavailable. Your transcript is preserved; the next question comes from the topic guide."})}
    finally{if(this.inflight.get(key)?.abort===abort)this.inflight.delete(key);await this.broadcast(s.roomId)}
  }
  async fail(roomId:string,error:unknown){this.logger.warn("Room action failed",{error:error instanceof Error?error.message:"Unknown failure"});if(error instanceof RelayError)await this.relayFailed();this.send(roomId,{type:"notice",level:"error",text:error instanceof Error?error.message:"The action failed. Please try again."});await this.broadcast(roomId).catch(()=>undefined)}
  private async relayFailed(){if(this.relayError)return;this.relayError="Agent delivery failed. Resume to retry.";for(const id of this.sockets.keys()){this.abort(id);await this.store.pauseSession(id,"relay-failure");const s=await this.broadcast(id);this.send(id,{type:"stop",generationEpoch:s.generationEpoch,reason:"Agent Relay unreachable"});this.send(id,{type:"providers",providers:this.providers()});this.send(id,{type:"notice",level:"error",text:"Agent Relay is unreachable. The seminar is paused."})}}
  private async watchActor(roomId:string){
    if(!this.store.subscribe||this.actorSubscriptions.has(roomId))return
    // Reserve the slot before awaiting the connection: simultaneous deliveries share one watcher.
    this.actorSubscriptions.set(roomId,()=>{})
    try{
      const unsubscribe=await this.store.subscribe(roomId,state=>{void this.observeActor(state).catch(error=>this.logger.warn("Actor update failed",{error:error instanceof Error?error.message:"Unknown error"}))},()=>{this.logger.debug("Actor socket reconnecting",{roomId})})
      this.actorSubscriptions.set(roomId,unsubscribe)
    }catch{this.actorSubscriptions.delete(roomId)}
  }
  private async observeActor(state:PublicRoomState){
    const previous=this.observed.get(state.roomId)
    const trace=state.counters.trace
    if(previous&&(state.generationEpoch<previous.epoch||state.version<previous.version||(state.version===previous.version&&(trace<previous.trace||trace===previous.trace&&state.updatedAt<previous.updatedAt))))return
    const signature=`${state.version}:${state.generationEpoch}:${state.phase}:${state.updatedAt}:${state.trace.at(-1)?.id??""}`
    this.observed.set(state.roomId,{epoch:state.generationEpoch,phase:state.phase,signature,version:state.version,trace,updatedAt:state.updatedAt})
    const role=this.options.role??"all"
    if(role!=="all"&&role!=="coordinator"){
      this.setPumpCadence([...this.observed.values()].some(room=>room.phase==="discussion")?"active":"idle")
      // A newly delivered turn opens a short fast-poll window. The actor update only wakes
      // the inbox: reasoning still requires the corresponding authenticated Relay delivery.
      if(state.phase==="discussion"&&!state.floor&&!state.turn.awaitingHuman&&(!previous||state.version>previous.version))this.pumps.boostAll()
    }
    if(previous?.signature===signature)return
    if(previous&&(state.generationEpoch!==previous.epoch||state.phase!==previous.phase)){
      for(const [key,work] of this.inflight){
        const reflection=key===`reflection-${state.roomId}`&&state.phase==="reflection"&&work.epoch===state.generationEpoch
        if(work.roomId===state.roomId&&(work.epoch<state.generationEpoch||state.phase!=="discussion"&&!reflection)){work.abort.abort();this.inflight.delete(key)}
      }
      const round=this.collectionStarted.get(state.roomId)
      if(round&&(round.epoch<state.generationEpoch||round.version<state.version||state.phase!=="discussion")){
        const timer=this.collections.get(state.roomId);if(timer)clearTimeout(timer);this.collections.delete(state.roomId);this.collectionStarted.delete(state.roomId)
      }
      this.send(state.roomId,{type:"stop",generationEpoch:state.generationEpoch,reason:state.pauseReason??"Actor changed the speaking turn"})
      this.send(state.roomId,{type:"thinking",speakerIds:[]})
    }
    this.send(state.roomId,{type:"snapshot",state})
    if((this.options.role??"all")!=="all"&&this.options.role!=="coordinator")return
    if(state.phase==="reflection"&&!state.reflection&&this.sockets.has(state.roomId)&&!this.inflight.has(`reflection-${state.roomId}`)){
      const full=await this.store.getSnapshot(state.roomId);if(full.phase==="reflection"&&!full.reflection)void this.reflect(full)
    }
  }
  private async tick(){
    if(this.ticking)return;this.ticking=true
    try{for(const id of this.sockets.keys()){
      const s=await this.store.getSnapshot(id);const {processedEventKeys:_,pendingOutbound:__,...publicState}=s;await this.observeActor(publicState);await this.watchActor(id);if(s.phase!=="discussion")continue
      if(s.floor&&s.floor.expiresAt<Date.now()){await this.serial(id,()=>this.pause(id,"speaker-timeout"));this.send(id,{type:"notice",level:"warning",text:"The speaker timed out. Resume when you’re ready."})}
      else if(s.budget.endsAt<Date.now()||s.budget.aiTurnsUsed>=s.budget.maxAiTurns){await this.handle(id,{type:"session.end"})}
      else if(s.turn.awaitingHuman&&s.turn.invitedAt&&s.config?.participation==="observe"&&Date.now()-s.turn.invitedAt>12000){await this.handle(id,{type:"human.pass"})}
    }}catch(error){this.logger.warn("Room watchdog failed",{error:error instanceof Error?error.message:"Unknown failure"})}finally{this.ticking=false}
  }
}
