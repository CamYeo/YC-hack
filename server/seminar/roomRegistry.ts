import { mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,chmodSync } from "node:fs"
import { join } from "node:path"
import { createHash,randomBytes,timingSafeEqual } from "node:crypto"
type RegisteredRoom={tokenSha256:string;createdAt:number;channel:string}
export function createRoomRegistry(root:string){
  const dir=join(root,".local");mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700)
  const path=join(dir,"rooms.json")
  let rooms:Record<string,RegisteredRoom>=existsSync(path)?JSON.parse(readFileSync(path,"utf8")) as Record<string,RegisteredRoom>:{}
  const hash=(s:string)=>createHash("sha256").update(s).digest()
  return {
    refresh(){ if(existsSync(path)) rooms=JSON.parse(readFileSync(path,"utf8")) as Record<string,RegisteredRoom> },
    ids:()=>Object.keys(rooms),has:(id:string)=>Object.hasOwn(rooms,id),
    create(id:string,channel:string){const token=randomBytes(32).toString("hex");rooms[id]={tokenSha256:hash(token).toString("hex"),createdAt:Date.now(),channel};const tmp=path+".tmp";writeFileSync(tmp,JSON.stringify(rooms),{mode:0o600});renameSync(tmp,path);return token},
    verify(id:string,token:string){const room=rooms[id];if(!room||!token)return false;const expected=Buffer.from(room.tokenSha256,"hex");const actual=hash(token);return expected.length===actual.length&&timingSafeEqual(expected,actual)}
  }
}
