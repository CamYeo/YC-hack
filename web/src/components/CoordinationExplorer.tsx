import { useEffect, useRef, useState } from 'react'
import { Button } from '@radix-ui/themes'
import rough from 'roughjs'
import { useSeminarTheme } from '../lib/theme'
import { Avatar, Pumpkin } from './Illustrations'
import { Icon } from './Icon'
import '../coordination.css'

type NodeId = 'human' | 'facilitator' | 'maya' | 'theo' | 'relay' | 'evidence' | 'coordinator' | 'terse'
type ScenarioId = 'propose' | 'evidence' | 'interrupt' | 'recover'
interface WalkthroughStep { title: string; detail: string; event: string; nodes: NodeId[]; edges: string[]; floor: string; epoch: number; heard: string; example?: string }
const scenarios: Record<ScenarioId, { label: string; steps: WalkthroughStep[] }> = {
  propose: { label: 'Propose', steps: [
    { title: 'You contribute', detail: 'Your contribution becomes part of the room context and is shared with the peers through Relay.', event: 'human.contributed', nodes: ['human', 'relay'], edges: ['human-relay'], floor: 'Open', epoch: 7, heard: 'Your question', example: 'What if the payment succeeded, but the response was lost?' },
    { title: 'A peer proposes a response', detail: '{maya} submits a proposed contribution through Relay. A proposal is silent until it receives a speaking turn.', event: 'floor.requested', nodes: ['maya', 'relay', 'coordinator'], edges: ['maya-relay', 'relay-coordinator'], floor: 'Open', epoch: 7, heard: 'Your question', example: 'A timeout tells us the response is missing. It does not tell us whether the charge happened.' },
    { title: 'The coordinator selects a turn', detail: 'Server logic checks current proposals, recent speakers, and the discussion’s turn policy. The facilitator is an AI participant, not the turn scheduler.', event: 'Proposal selection', nodes: ['coordinator', 'terse'], edges: ['coordinator-terse'], floor: 'Requested', epoch: 7, heard: 'Your question' },
    { title: 'Terse grants the floor', detail: 'The room actor grants one exclusive speaking lease. Voice is generated only for the approved contribution.', event: 'floor.granted', nodes: ['terse', 'maya'], edges: ['terse-maya'], floor: '{maya}', epoch: 7, heard: 'Your question' },
    { title: 'Delivered speech reaches the others', detail: 'Completed speech segments enter the shared conversation. Relay carries that contribution to peers so their next proposals can respond to it.', event: 'contribution.heard', nodes: ['maya', 'human', 'relay', 'theo', 'facilitator'], edges: ['maya-human', 'maya-relay', 'theo-relay', 'facilitator-relay'], floor: 'Open', epoch: 7, heard: '1 AI contribution' },
  ] },
  evidence: { label: 'Check evidence', steps: [
    { title: 'A peer asks for a check', detail: '{theo} proposes checking the payment-retry example instead of relying on an unsupported claim.', event: 'floor.requested', nodes: ['theo', 'relay', 'coordinator'], edges: ['theo-relay', 'relay-coordinator'], floor: 'Open', epoch: 12, heard: 'Current discussion', example: 'Can we test what happens when the retry has no idempotency key?' },
    { title: 'Relay routes the request', detail: 'The coordinator sends a tool request to the evidence worker through Relay. The worker does not speak.', event: 'evidence.requested', nodes: ['coordinator', 'relay', 'evidence'], edges: ['relay-coordinator', 'evidence-relay'], floor: 'Open', epoch: 12, heard: 'Current discussion' },
    { title: 'The worker runs a local experiment', detail: 'The selected payment-retry case runs deterministically. Its assumptions and limitations accompany the result.', event: 'payment-retry-sim', nodes: ['evidence'], edges: [], floor: 'Open', epoch: 12, heard: 'Current discussion', example: 'Example case: the first charge commits, its response is lost, and a retry uses no deduplication key.' },
    { title: 'The result becomes shared evidence', detail: 'Relay returns the result. Terse records it, and the discussion opens a new turn that can reference the finding.', event: 'evidence.returned', nodes: ['evidence', 'relay', 'terse'], edges: ['evidence-relay', 'relay-terse'], floor: 'Open', epoch: 13, heard: 'Evidence available' },
    { title: 'Peers discuss the finding', detail: '{facilitator}, {maya}, and {theo} receive the updated context and can propose a response grounded in that result.', event: 'floor.opened', nodes: ['relay', 'facilitator', 'maya', 'theo'], edges: ['facilitator-relay', 'maya-relay', 'theo-relay'], floor: 'Open', epoch: 13, heard: 'Evidence available' },
  ] },
  interrupt: { label: 'Jump in', steps: [
    { title: 'An AI peer is speaking', detail: '{maya} has an exclusive speaking turn. The browser acknowledges completed speech segments.', event: 'playback.segment', nodes: ['maya', 'human', 'terse'], edges: ['maya-human', 'terse-maya'], floor: '{maya}', epoch: 20, heard: '1 completed sentence' },
    { title: 'You interrupt', detail: 'Jump in stops browser playback immediately and tells the server to revoke the current turn.', event: 'human.jumpIn', nodes: ['human', 'coordinator'], edges: ['human-coordinator'], floor: 'Revoking', epoch: 20, heard: '1 completed sentence' },
    { title: 'Terse invalidates old work', detail: 'The room clears its speaking lease and advances the cancellation epoch. Pending generation is cancelled.', event: 'floor.revoked', nodes: ['coordinator', 'terse'], edges: ['coordinator-terse'], floor: 'Yours', epoch: 21, heard: '1 completed sentence' },
    { title: 'Late speech stays out', detail: 'Old-epoch playback cannot resume. Conversation context retains only the acknowledged, delivered portion of the interrupted contribution.', event: 'Epoch check', nodes: ['terse', 'maya', 'human'], edges: ['terse-maya'], floor: 'Yours', epoch: 21, heard: '1 completed sentence' },
    { title: 'Your new point redirects the exchange', detail: 'Your contribution is shared through Relay and becomes the context for the next proposals.', event: 'human.contributed', nodes: ['human', 'relay', 'facilitator', 'theo'], edges: ['human-relay', 'facilitator-relay', 'theo-relay'], floor: 'Open', epoch: 21, heard: 'Your new contribution' },
  ] },
  recover: { label: 'Recover', steps: [
    { title: 'The room pauses', detail: 'A disconnected listener pauses the room and stops its active work. The room’s discussion state is persisted in Terse.', event: 'session.paused', nodes: ['human', 'coordinator', 'terse'], edges: ['coordinator-terse'], floor: 'Paused', epoch: 31, heard: 'Saved transcript' },
    { title: 'Terse reloads the record', detail: 'After a service restart, the backend recovers the stored room, including contributions, reasoning notes, and evidence.', event: 'Room recovery', nodes: ['terse'], edges: [], floor: 'Paused', epoch: 31, heard: 'Saved transcript' },
    { title: 'Stale speaking work is invalidated', detail: 'Recovery prevents a previous speaking lease from continuing as if the disconnect never happened.', event: 'Recovery cancellation', nodes: ['terse', 'coordinator'], edges: ['coordinator-terse'], floor: 'Paused', epoch: 32, heard: 'Saved transcript' },
    { title: 'The browser receives the room snapshot', detail: 'The backend sends the recovered snapshot to the browser. Playback waits for an explicit resume action.', event: 'snapshot', nodes: ['terse', 'coordinator', 'human'], edges: ['coordinator-terse', 'human-coordinator'], floor: 'Paused', epoch: 32, heard: 'Saved transcript' },
    { title: 'You resume the discussion', detail: 'Resume shares an updated event through Relay. Peers can propose fresh contributions using the recovered context.', event: 'session.resumed', nodes: ['human', 'relay', 'facilitator', 'maya', 'theo'], edges: ['human-relay', 'facilitator-relay', 'maya-relay', 'theo-relay'], floor: 'Open', epoch: 32, heard: 'Saved transcript' },
  ] },
}

const edges = [
  ['human-relay', 'M80 117 C80 180 218 152 299 217'],
  ['facilitator-relay', 'M260 119 C260 165 294 170 324 203'],
  ['maya-relay', 'M440 119 C440 166 405 170 376 203'],
  ['theo-relay', 'M620 117 C620 179 479 153 401 217'],
  ['evidence-relay', 'M126 235 C180 228 224 243 285 235'],
  ['relay-coordinator', 'M415 235 C473 227 517 243 563 235'],
  ['human-coordinator', 'M80 117 C80 318 552 339 620 276'],
  ['coordinator-terse', 'M620 276 C620 351 513 390 469 390'],
  ['relay-terse', 'M350 293 C348 312 351 327 350 347'],
  ['terse-human', 'M231 392 C20 399 9 258 80 117'],
  ['terse-maya', 'M469 390 C532 344 527 180 440 119'],
  ['maya-human', 'M410 64 C313 11 189 12 111 63'],
] as const

function DiagramFrames() {
  const ref = useRef<SVGSVGElement>(null)
  const { theme } = useSeminarTheme()
  useEffect(() => {
    if (!ref.current) return
    const svg = ref.current
    svg.replaceChildren()
    const draw = rough.svg(svg)
    const options = { seed: 23, stroke: theme === 'halloween' ? '#c7804c' : '#97a187', strokeWidth: 1, roughness: 1.3 }
    svg.append(draw.ellipse(350, 235, 130, 116, options))
    svg.append(draw.rectangle(221, 348, 258, 90, options))
    svg.append(draw.path('M234 447 L468 445', { ...options, strokeWidth: .6 }))
  }, [theme])
  return <svg ref={ref} className="coord-frames" viewBox="0 0 700 460" preserveAspectRatio="none" aria-hidden="true"/>
}

function RelayGlyph() { return <svg viewBox="0 0 36 30" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 8 18 15 28 7M18 15l10 10M18 15 8 24"/><circle cx="6" cy="7" r="4"/><circle cx="30" cy="6" r="4"/><circle cx="18" cy="15" r="4"/><circle cx="30" cy="26" r="3"/><circle cx="6" cy="25" r="3"/></svg> }
function EvidenceGlyph() { return <svg viewBox="0 0 32 34" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M11 3h10M13 3v11L5 27q-2 4 3 4h17q4 0 2-4l-9-13V3M9 21h15M12 25h2m5 2h3"/></svg> }

export function CoordinationExplorer() {
  const { theme, names, shortNames } = useSeminarTheme()
  const [scenarioId, setScenarioId] = useState<ScenarioId>('propose')
  const [stepIndex, setStepIndex] = useState(0)
  const [inspectedNode, setInspectedNode] = useState<NodeId | null>(null)
  const scenario = scenarios[scenarioId]
  const step = scenario.steps[stepIndex] ?? scenario.steps[0]
  if (!step) return null
  const display = (text: string) => text.replace(/\{(facilitator|maya|theo)\}/g, (_, id: 'facilitator' | 'maya' | 'theo') => shortNames[id])
  const nodeName = (id: NodeId) => id === 'relay' ? 'Agent Relay' : id === 'terse' ? 'Terse' : id === 'coordinator' ? 'Turn coordinator' : id === 'evidence' ? 'Evidence worker' : names[id]
  const nodeDetails: Record<NodeId, { role: string; rows: [string, string][]; link?: string }> = {
    human: { role: 'Human participant', rows: [['Input', 'Voice or text'], ['Control', 'Interrupt, pause, resume'], ['Context', 'Your contributions join the discussion']] },
    facilitator: { role: 'AI facilitator', rows: [['Contributes', 'Questions and connections'], ['Receives', 'Shared conversation and evidence'], ['Audio', 'Only after floor approval']] },
    maya: { role: 'AI peer', rows: [['Contributes', 'Proposals and alternative explanations'], ['Responds to', 'Humans and other AI peers'], ['Audio', 'Only after floor approval']] },
    theo: { role: 'AI peer', rows: [['Contributes', 'Counterexamples and evidence requests'], ['Responds to', 'Humans and other AI peers'], ['Audio', 'Only after floor approval']] },
    relay: { role: 'Message transport', rows: [['Carries', 'Proposals, contributions, evidence'], ['Routes to', 'Peers, coordinator, evidence worker'], ['Purpose', 'Causal communication between participants']], link: 'https://agentrelay.com/' },
    evidence: { role: 'Silent tool worker', rows: [['Receives', 'Explicit evidence requests'], ['Runs', 'Deterministic topic tools'], ['Returns', 'Results, assumptions, limitations']] },
    coordinator: { role: 'Deterministic server logic', rows: [['Checks', 'Current proposals and discussion policy'], ['Requests', 'An exclusive speaking lease'], ['Is', 'Room logic; no extra AI speaker']] },
    terse: { role: 'Durable room actor', rows: [['Persists', 'Transcript, notes, evidence, room state'], ['Enforces', 'One speaking lease at a time'], ['Cancels', 'Outdated work through epochs'], ['Recovers', 'Stored state after restart']], link: 'https://www.useterse.ai/' },
  }
  const selectScenario = (id: ScenarioId) => { setScenarioId(id); setStepIndex(0); setInspectedNode(null) }
  const selectStep = (index: number) => { setStepIndex(index); setInspectedNode(null) }
  const nodeClass = (id: NodeId) => `coord-node coord-${id} ${step.nodes.includes(id) ? 'is-active' : ''} ${inspectedNode === id ? 'is-inspected' : ''}`
  return <section id="under-the-hood" className="sponsor-story coordination-explorer" aria-labelledby="sponsor-title">
    <div className="coord-section-heading"><h2 id="sponsor-title">{theme === 'halloween' && <Pumpkin size={28}/>}Agent coordination</h2><div className="coord-mode"><span/>Illustrative walkthrough <small>Not live events</small></div></div>
    <div className="coord-toolbar"><div className="coord-scenarios" role="group" aria-label="Coordination scenario">{(Object.keys(scenarios) as ScenarioId[]).map(id => <Button key={id} size="2" radius="full" variant={scenarioId === id ? 'solid' : 'soft'} aria-pressed={scenarioId === id} onClick={() => selectScenario(id)}>{scenarios[id].label}</Button>)}</div><span className="coord-example-label">Example: checkout retry</span></div>
    <div className="coord-workspace">
      <div className="coord-diagram-panel"><div className="coord-diagram" aria-label="Interactive agent network. Select a node to inspect its role.">
        <svg className="coord-connections" viewBox="0 0 700 460" preserveAspectRatio="none" aria-hidden="true">{edges.map(([id, path]) => <path key={id} d={path} className={step.edges.includes(id) ? 'is-active' : ''}/>)}</svg><DiagramFrames/>
        {(['human', 'facilitator', 'maya', 'theo'] as const).map(id => <button className={`${nodeClass(id)} coord-person`} key={id} onClick={() => setInspectedNode(id)} aria-pressed={inspectedNode === id} aria-label={`Inspect ${nodeName(id)}`}>{id === 'human' ? <span className="coord-human-avatar">You</span> : <Avatar id={id}/>}<strong>{id === 'human' ? 'You' : shortNames[id]}</strong><small>{id === 'human' ? 'Human' : id === 'facilitator' ? 'AI facilitator' : 'AI peer'}</small></button>)}
        <button className={nodeClass('relay')} onClick={() => setInspectedNode('relay')} aria-pressed={inspectedNode === 'relay'}><RelayGlyph/><strong>Agent Relay</strong><small>Messages</small></button>
        <button className={nodeClass('evidence')} onClick={() => setInspectedNode('evidence')} aria-pressed={inspectedNode === 'evidence'}><EvidenceGlyph/><strong>Evidence</strong><small>Silent worker</small></button>
        <button className={nodeClass('coordinator')} onClick={() => setInspectedNode('coordinator')} aria-pressed={inspectedNode === 'coordinator'}><Icon name="settings" size={29}/><strong>Coordinator</strong><small>Server logic</small></button>
        <button className={nodeClass('terse')} onClick={() => setInspectedNode('terse')} aria-pressed={inspectedNode === 'terse'}><span className="coord-terse-name">Terse <small>Example room state</small></span><span className="coord-state-values"><span>Floor <b>{display(step.floor)}</b></span><span>Epoch <b>{step.epoch}</b></span></span><span className="coord-state-heard">{step.heard}</span></button>
      </div><div className="coord-diagram-caption"><span><i/>Highlighted route</span><span>Select any node to inspect it</span></div></div>
      <aside className="coord-inspector" aria-live="polite" aria-atomic="true">
        {inspectedNode ? <><div className="coord-inspector-top"><span>Component</span><button aria-label="Return to walkthrough step" onClick={() => setInspectedNode(null)}><Icon name="close" size={16}/></button></div><h3>{nodeName(inspectedNode)}</h3><span className="coord-node-role">{nodeDetails[inspectedNode].role}</span><dl className="coord-detail-list">{nodeDetails[inspectedNode].rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{nodeDetails[inspectedNode].link && <a className="coord-component-link" href={nodeDetails[inspectedNode].link} target="_blank" rel="noreferrer">Visit {nodeName(inspectedNode)} ↗</a>}</> : <><div className="coord-inspector-top"><span>{scenario.label}</span><span>{String(stepIndex + 1).padStart(2, '0')} / {String(scenario.steps.length).padStart(2, '0')}</span></div><h3>{step.title}</h3><code className="coord-event-name">{step.event}</code><p className="coord-step-detail">{display(step.detail)}</p>{step.example && <div className="coord-example"><span>Illustrative content</span><p>{display(step.example)}</p></div>}</>}
        <div className="coord-step-controls"><Button size="2" radius="full" variant="soft" disabled={stepIndex === 0} aria-label="Previous walkthrough step" onClick={() => selectStep(stepIndex - 1)}><span className="coord-back-arrow"><Icon name="arrow" size={16}/></span></Button><Button size="2" radius="full" variant="soft" onClick={() => selectStep(stepIndex === scenario.steps.length - 1 ? 0 : stepIndex + 1)}>{stepIndex === scenario.steps.length - 1 ? 'Restart' : 'Next step'}<Icon name="arrow" size={16}/></Button></div>
      </aside>
    </div>
    <div className="coord-step-strip" role="group" aria-label="Walkthrough steps">{scenario.steps.map((item, index) => <button key={`${scenarioId}-${index}`} className={index === stepIndex ? 'is-current' : index < stepIndex ? 'is-complete' : ''} aria-pressed={index === stepIndex} aria-label={`Step ${index + 1}: ${item.title}`} onClick={() => selectStep(index)}><span>{index < stepIndex ? <Icon name="check" size={12}/> : index + 1}</span><strong>{item.title}</strong></button>)}</div>
    <div className="coord-sponsor-links"><a href="https://www.useterse.ai/" target="_blank" rel="noreferrer"><span className="coord-sponsor-mark">T</span><span><strong>Terse</strong><small>Room state & exclusive floor</small></span><span>↗</span></a><a href="https://agentrelay.com/" target="_blank" rel="noreferrer"><span className="coord-sponsor-mark"><RelayGlyph/></span><span><strong>Agent Relay</strong><small>Peer messages & evidence</small></span><span>↗</span></a></div>
  </section>
}
