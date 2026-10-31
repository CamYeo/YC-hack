import type { EvidenceResult } from "../../actor/src/roomTypes"
import type { ToolRunner } from "../agents/types"
export function paymentRetry(caseId:string):EvidenceResult {
  if(!["no-key-retry","stable-key-retry","new-key-retry"].includes(caseId))throw new Error("Unknown payment experiment")
  const stable=caseId==="stable-key-retry"
  const keys=caseId==="no-key-retry"?[null,null]:stable?["purchase-1","purchase-1"]:["attempt-1","attempt-2"]
  const receipts=new Map<string,string>();let charges=0
  const events:EvidenceResult["events"]=[]
  for(let i=0;i<2;i++){
    const key=keys[i]??null;const existing=key?receipts.get(key):undefined
    events.push({t:i*1000,actor:"client",label:i===0?"Initial request":"Retry",detail:key?`key = ${key}`:"No idempotency key"})
    if(existing)events.push({t:i*1000+100,actor:"server",label:"Stored receipt returned",detail:existing})
    else {charges++;const receipt=`receipt-${charges}`;if(key)receipts.set(key,receipt);events.push({t:i*1000+100,actor:"server",label:"Charge committed",detail:receipt})}
    if(i===0)events.push({t:800,actor:"network",label:"Response lost",detail:"Client times out after the server has committed."})
  }
  return {kind:"experiment",title:stable?"Same key, one charge":caseId==="new-key-retry"?"New keys, two charges":"No key, two charges",assumptions:["The first payment commits, then its response is lost.","The simulated server atomically stores and reuses receipts by idempotency key.","Both attempts have the same purchase payload and occur inside the retention window."],observations:[`Two attempts produced ${charges} charge${charges===1?"":"s"}.`,stable?"The retry returned the first receipt.":"The retry created a second receipt."],sourceStatements:[],limitations:["This is a toy simulation, not a real payment service.","A header alone is insufficient: server deduplication, payload checks, concurrency and retention policy matter."],unresolved:["How should an actual server handle concurrent requests or expired keys?"],metrics:{attempts:2,charges},events}
}
export function createToolRunner():ToolRunner { return {run({topic,toolId,caseId}){
  const tool=topic.tools.find(t=>t.id===toolId)
  if(!tool)return {status:"failed",error:"This tool is not available for this topic."}
  if(caseId!==null&&!tool.cases.some(c=>c.id===caseId))return {status:"failed",error:"Unknown case for this tool."}
  try{
    if(toolId==="payment-retry-sim")return {status:"returned",result:paymentRetry(caseId??"no-key-retry")}
    if(toolId==="source-lookup"){if(!topic.sources.length)return {status:"failed",error:"No sources are bundled with this topic."};return {status:"returned",result:{kind:"source",title:"Reading notes",assumptions:["These are brief bundled summaries."],observations:[],sourceStatements:topic.sources.flatMap(s=>s.keyPoints.map(statement=>({sourceId:s.id,statement}))),limitations:["Read the linked source for its full context."],unresolved:[],metrics:{sources:topic.sources.length},events:[]}}}
    if(toolId==="multiply-check" && (caseId===null||caseId==="examples")){
      const examples=[[4,2],[4,.5],[4,1],[4,0],[4,-2],[-4,2],[-4,.5]]
      return {status:"returned",result:{kind:"calculation",title:"Counterexamples to a universal claim",assumptions:["Real-number arithmetic; bigger means greater, not greater absolute value."],observations:examples.map(([a=0,b=0])=>`${a} × ${b} = ${a*b}; ${a*b>a?"greater than":a*b<a?"less than":"equal to"} ${a}.`),sourceStatements:[],limitations:["One counterexample refutes 'always'. A finite list does not prove a general theorem."],unresolved:["How does the answer depend on the signs of a and b?"],metrics:{examples:examples.length},events:[]}}
    }
    return {status:"failed",error:"Unknown tool or case."}
  }catch{return {status:"failed",error:"The requested experiment could not run."}}
}} }
