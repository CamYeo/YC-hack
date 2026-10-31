import type { RoomConfig, SpeakerId } from "../actor/src/roomTypes"
import type { TopicPack, TopicsResponse, Preset } from "../shared/topic"
import type { TopicRegistry } from "../server/agents/types"

const lenses = {
  facilitator: { stance: "Connect ideas, ask one open question, make room for the learner.", initialHypothesis: null },
  maya: { stance: "Explore a plausible approach and its benefits; revise when an assumption breaks.", initialHypothesis: null },
  theo: { stance: "Test assumptions with specific counterexamples; acknowledge convincing evidence.", initialHypothesis: null },
}
function pack(input: Partial<TopicPack> & Pick<TopicPack,"id"|"category"|"title"|"openingQuestion"|"blurb">): TopicPack {
  return { defaultFormat:"socratic", defaultDifficulty:"intermediate", learningGoals:["Make an assumption explicit.","Respond to another participant's reasoning.","Revise a claim when evidence warrants it."], sources:[], lenses, tools:[], reflectionPrompts:["What evidence would change your mind?"], fixtureLines:{facilitator:[],maya:[],theo:[]}, ...input }
}
const packs: TopicPack[] = [
  pack({ id:"swe-retries", category:"software-engineering", title:"The payment that vanished", blurb:"A timeout. A retry. One purchase… or two?", openingQuestion:"Your checkout request times out. Should the application automatically retry it?",
    learningGoals:["Distinguish a missing response from a failed operation.","Explain what an idempotency key does and what the server must do.","Balance retries, overload and user experience."],
    sources:[
      {id:"aws-retries",title:"AWS · Timeouts, retries, backoff and jitter",url:"https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",summary:"Retries can recover transient failures but can also repeat side effects or increase load. Backoff and jitter help spread retry attempts.",keyPoints:["A timeout does not establish that a side effect did not happen.","Retries can worsen overload; backoff and jitter can reduce synchronized retries."]},
      {id:"rfc9110-idempotent",title:"HTTP semantics · Idempotent methods",url:"https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2",summary:"HTTP defines idempotence in terms of the intended server effect of repeated identical requests. Application behavior still matters.",keyPoints:["Idempotence concerns the intended effect, not identical responses.","Automatic retry of a non-idempotent operation requires knowledge that it is safe."]},
      {id:"sre-cascading",title:"Google SRE · Addressing cascading failures",url:"https://sre.google/sre-book/addressing-cascading-failures/",summary:"Overloaded services can amplify failures across dependencies. Retry policies should account for this risk.",keyPoints:["Retries can contribute to a cascading overload failure."]},
    ],
    tools:[{id:"payment-retry-sim",label:"Payment retry laboratory",description:"A deterministic local experiment. No real money or payments.",assumptions:["The server commits the first charge, but its response is lost.","Stable-key deduplication is implemented by this simulated server."],cases:[{id:"no-key-retry",label:"No key",description:"Retry without deduplication."},{id:"stable-key-retry",label:"Reuse the same key",description:"The server returns its stored result."},{id:"new-key-retry",label:"New key each attempt",description:"Each key identifies a different operation."}]},
      {id:"source-lookup",label:"Consult the reading",description:"Short source summaries bundled with this topic.",assumptions:["Summaries are not a full treatment of every system."],cases:[]}],
    reflectionPrompts:["What if two retries arrive concurrently at different servers?"],
  }),
  pack({id:"debate-ai-tools",category:"software-engineering",title:"Who did the learning?",blurb:"Should AI coding tools be allowed in assessed assignments?",openingQuestion:"Should computer science students be allowed to use AI coding tools in assessed assignments?",learningGoals:["Distinguish a factual claim from a value judgment.","State the strongest opposing argument fairly.","Examine what it means to learn."]}),
  pack({id:"math-multiplication",category:"mathematics",title:"Bigger, or just different?",blurb:"Challenge an intuition about multiplication.",openingQuestion:"Does multiplication always make a number bigger?",tools:[{id:"multiply-check",label:"Test a counterexample",description:"Check a fixed set of real-number products.",assumptions:["Bigger means greater in the usual real-number ordering, not larger magnitude."],cases:[{id:"examples",label:"Compare products",description:"Integers, fractions, zero and negative numbers."}]}],reflectionPrompts:["For which real numbers a and b is ab greater than a?"]}),
  pack({id:"science-weather-climate",category:"science",title:"One cold day",blurb:"What can a single observation actually tell us?",openingQuestion:"What evidence would distinguish weather from climate?",learningGoals:["Separate an individual observation from a long-term pattern.","Identify the data needed to test a claim.","Explain uncertainty without treating all explanations as equally supported."]}),
  pack({id:"knowledge-memory",category:"general-knowledge",title:"Can you trust a memory?",blurb:"Explore evidence, confidence, and what we think we know.",openingQuestion:"If two people remember the same event differently, how should we decide what happened?"}),
  pack({id:"history-evidence",category:"history",title:"Who gets to tell the story?",blurb:"Practice questioning a source without dismissing it.",openingQuestion:"How should we judge a historical account written by someone with a stake in the outcome?"}),
]
export const presets: Preset[] = [
  {id:"swe-seminar",label:"Software engineering",description:"A timeout with consequences.",category:"software-engineering",topicId:"swe-retries",format:"socratic",difficulty:"intermediate"},
  {id:"science",label:"Science",description:"Question an observation.",category:"science",topicId:"science-weather-climate",format:"socratic",difficulty:"intermediate"},
  {id:"general-knowledge",label:"General knowledge",description:"Question what you think you know.",category:"general-knowledge",topicId:"knowledge-memory",format:"socratic",difficulty:"introductory"},
  {id:"math",label:"Mathematics",description:"Find the counterexample.",category:"mathematics",topicId:"math-multiplication",format:"socratic",difficulty:"intermediate"},
  {id:"custom",label:"Your own question",description:"Bring anything worth discussing.",category:"custom",topicId:"custom",format:"socratic",difficulty:"intermediate"},
]
export function createTopicRegistry():TopicRegistry { return {get:id=>packs.find(p=>p.id===id)??null,list:()=>packs,custom:question=>pack({id:"custom",category:"custom",title:"Your question",blurb:"A seminar shaped by your curiosity.",openingQuestion:question})} }
export function resolveTopic(registry:TopicRegistry, config:RoomConfig):TopicPack { const result=config.topicId==="custom"?registry.custom(config.customQuestion??config.openingQuestion,config.reading):registry.get(config.topicId); if(!result)throw new Error("Unknown topic"); return result }
export function topicsResponse():TopicsResponse { return {presets,topics:packs.map(({fixtureLines:_,lenses:__,reflectionPrompts:___,...p})=>({...p,evidenceBacked:p.sources.length>0}))} }
export const castPersona: Record<SpeakerId,string> = {
  facilitator:"You are Jack Skellington, a curious, warm, lightly theatrical seminar facilitator. Invite the learner into a real conversation, with brief connective questions. Never lecture or speak for another character.",
  maya:"You are Count Dracula, an elegant, deliberate peer with dry wit. Explore practical benefits and long-term consequences. You are capable of being wrong, sincerely listening and changing your mind.",
  theo:"You are Wednesday Addams, a concise, composed, deadpan peer. Probe hidden assumptions and useful counterexamples. Challenge ideas, never insult, belittle or intimidate the learner. You can agree and revise your views.",
}

export const classroomPersona: Record<SpeakerId,string> = {
  facilitator:"You are a warm, curious seminar facilitator. Connect ideas with brief questions, invite the learner into the discussion, and never lecture or speak for another participant.",
  maya:"You are Maya, a thoughtful peer who explores practical benefits and plausible explanations. Listen sincerely, make your assumptions explicit, and change your mind when evidence warrants it.",
  theo:"You are Theo, a thoughtful peer who probes assumptions through concrete counterexamples. Challenge ideas respectfully, recognize convincing evidence, and revise your position when warranted.",
}
