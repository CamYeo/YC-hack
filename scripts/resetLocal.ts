import { mkdirSync,existsSync,renameSync } from "node:fs"
import { resolve,join } from "node:path"
const root=resolve(import.meta.dir,"..")
for(const port of [3001,7100]){
  let running=false
  try{await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(800)});running=true}catch{/* No listening service is expected. */}
  if(running){process.stderr.write("Stop the APPRENTICE development services before resetting local rooms.\n");process.exit(1)}
}
const backup=join(root,".local","backups",new Date().toISOString().replace(/[:.]/g,"-"))
mkdirSync(backup,{recursive:true,mode:0o700})
for(const [source,name] of [["actor/.durable-actors","actor-state"],[".local/rooms.json","rooms.json"]] as const){
  const path=resolve(root,source);if(existsSync(path))renameSync(path,join(backup,name))
}
process.stdout.write(`Local rooms archived to ${backup}. Hackathon credentials and Relay identities are preserved.\n`)
