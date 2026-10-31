import { resolve,dirname } from "node:path"
import { existsSync } from "node:fs"
import { bootstrapRelay } from "./relayBootstrap"
import { readHackathonFile,readRelayConfig } from "../server/config/hackathonConfig"

const root=resolve(import.meta.dir,"..")
const executable=resolve(root,"node_modules/.bin/bun")
const env:Record<string,string>={PATH:`${dirname(executable)}:${process.env.PATH??"/usr/bin:/bin"}`,HOME:process.env.HOME??"",USER:process.env.USER??"",TMPDIR:process.env.TMPDIR??"/tmp",LANG:"en_US.UTF-8",NO_COLOR:"1"}
const children:ReturnType<typeof Bun.spawn>[]=[]
const peerArg=process.argv.indexOf("--external-peer")
const externalPeer=peerArg>=0?process.argv[peerArg+1]:null
if(externalPeer&&!(["maya","theo"].includes(externalPeer)))throw new Error("--external-peer must be maya or theo")
let stopping=false
async function stop(code=0){if(stopping)return;stopping=true;for(const child of children)child.kill("SIGTERM");await Promise.all(children.map(c=>c.exited));process.exit(code)}
process.on("SIGINT",()=>{void stop()});process.on("SIGTERM",()=>{void stop()})
function launch(args:string[],cwd=root,restart=false){const p=Bun.spawn([executable,...args],{cwd,env,stdout:"inherit",stderr:"inherit",stdin:"ignore"});children.push(p);void p.exited.then(code=>{if(!stopping){if(restart){process.stderr.write(`Restarting ${args[0]} after exit ${code}.\n`);setTimeout(()=>{if(!stopping)launch(args,cwd,true)},600)}else{process.stderr.write(`A development service stopped (${code}).\n`);void stop(code||1)}}});return p}
async function waitFor(url:string){for(let i=0;i<100;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(700)});if(r.ok)return}catch{/* The service may still be starting. */}await Bun.sleep(500)}throw new Error(`Service did not become ready: ${url}`)}
try{
  if(!existsSync(executable))throw new Error("Run bun install before starting the app")
  if(!readRelayConfig(root)){
    try{await bootstrapRelay(root)}catch(error){if(readHackathonFile(root).APP_MODE==="live")throw error;process.stderr.write("Agent Relay setup unavailable; fixture mode will be clearly labelled. Run bun run relay:bootstrap to retry.\n")}
  }
  launch([resolve(root,"node_modules/terse-cli/dist/index.js"),"actor","dev","--port","7100","--project-id","local"],resolve(root,"actor"))
  await waitFor("http://127.0.0.1:7100/v1/projects/local/deployment/contract")
  const distributed=!!readRelayConfig(root)
  launch(["server/index.ts",...(distributed?["--distributed"]:[])],root,true)
  await waitFor("http://127.0.0.1:3001/api/status")
  if(distributed)for(const role of ["facilitator","maya","theo","evidence"])if(role!==externalPeer)launch(["server/agents/worker.ts",role],root,true)
  if(externalPeer)process.stdout.write(`External peer seat reserved: ${externalPeer}. Connect worker.ts ${externalPeer} --stdio before starting the seminar.\n`)
  launch([resolve(root,"node_modules/vite/bin/vite.js"),"--config",resolve(root,"web/vite.config.ts"),"--host","127.0.0.1"])
  await waitFor("http://127.0.0.1:5173")
  process.stdout.write("\nAPPRENTICE is ready at http://127.0.0.1:5173\nCtrl+C stops the local services and agent workers.\n")
}catch(error){process.stderr.write(`${error instanceof Error?error.message:"Startup failed"}\n`);await stop(1)}
await new Promise(()=>{})
