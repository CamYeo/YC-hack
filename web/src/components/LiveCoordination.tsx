import { useEffect, useState } from 'react'
import type { PublicRoomState, TraceEntry } from '../../../actor/src/roomTypes'
import type { ProviderStatus } from '../../../shared/contracts'
import { useSeminarTheme } from '../lib/theme'
import { Icon } from './Icon'
import './live-coordination.css'

const eventNames: Record<string, string> = {
  'session.started': 'Discussion started', 'human.contributed': 'Your contribution delivered',
  'contribution.heard': 'Spoken contribution delivered', 'floor.requested': 'Turn proposed',
  'floor.granted': 'Speaking turn granted', 'floor.revoked': 'Speaking turn cancelled',
  'evidence.requested': 'Evidence requested', 'evidence.returned': 'Evidence returned',
  'session.paused': 'Discussion paused', 'session.resumed': 'Discussion resumed',
  'recovery.restored': 'Room recovered', 'alarm.floor-expired': 'Speaking turn expired',
  'alarm.session-ended': 'Session deadline reached', 'worker.thinking': 'Worker generating a proposal',
}
function activity(state: PublicRoomState) {
  const seen = new Set<string>()
  return [...state.trace].reverse().filter(event => {
    if (event.channel !== 'relay' && event.channel !== 'terse' && event.kind !== 'worker.thinking') return false
    const key = `${event.kind}:${event.relayMessageId ?? event.eventId ?? event.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 14)
}

export function LiveCoordination({ state, providers, connected }: { state: PublicRoomState; providers: ProviderStatus | null; connected: boolean }) {
  const { names, shortNames } = useSeminarTheme()
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const entries = activity(state)
  const current = entries.find(entry => entry.id === selected) ?? entries[0]
  const pretty = (id: string) => id === 'bridge' ? 'Coordinator' : id === 'SeminarActor' ? 'Terse' : id === 'learner' ? 'You' : id.startsWith('sem-') ? 'Room channel' : shortNames[id as keyof typeof shortNames] ?? id
  const recent = (entry: TraceEntry | undefined) => !!entry && now - entry.at < 5000 && connected && state.phase === 'discussion'
  const peerActive = (id: string) => state.floor?.speakerId === id || entries.some(entry => recent(entry) && (entry.from === id || entry.to === id))
  const relayActive = entries.some(entry => entry.channel === 'relay' && recent(entry))
  const mode = providers?.relay.mode === 'fixture' ? 'Fixture' : providers?.relay.deliveryMode === 'websocket' ? 'WebSocket' : 'Durable polling'
  const proposal = current?.eventId ? state.pendingProposals.find(item => item.eventId === current.eventId) : undefined
  const latestRecovery = state.trace.findLast(entry => entry.kind === 'recovery.restored')
  return <section className="live-coordination" aria-label="Live agent coordination">
    <div className="coordination-live-status"><span className={connected ? 'connection-dot connected' : 'connection-dot'}/><span>{connected ? 'Room connected' : 'Reconnecting'}</span><span>{mode}</span></div>
    <div className={`live-network ${relayActive ? 'relay-active' : ''}`} aria-label="Live room network">
      <svg viewBox="0 0 280 205" aria-hidden="true"><path d="M45 32L140 104M140 32L140 104M235 32L140 104M140 104L45 178M140 104L140 178M140 104L235 178"/></svg>
      {(['maya', 'facilitator', 'theo'] as const).map((id, index) => <div key={id} className={`network-node peer-node peer-${index} ${peerActive(id) ? 'node-active' : ''}`}><span className="node-disc">{id === 'facilitator' ? <Icon name="compass" size={19}/> : names[id].slice(0, 1)}</span><span>{shortNames[id]}</span></div>)}
      <div className={`network-node relay-node ${relayActive ? 'node-active' : ''}`}><span className="node-disc"><Icon name="arrow" size={21}/></span><span>Agent Relay</span></div>
      <div className={`network-node evidence-node ${peerActive('evidence') ? 'node-active' : ''}`}><span className="node-disc"><Icon name="book" size={18}/></span><span>Evidence</span></div>
      <div className={`network-node human-node ${state.turn.awaitingHuman ? 'node-active' : ''}`}><span className="node-disc">Y</span><span>You</span></div>
      <div className={`network-node actor-node ${state.floor ? 'node-active' : ''}`}><span className="node-disc">T</span><span>Terse</span></div>
    </div>
    <div className="actor-facts"><span>Floor <strong>{state.floor ? shortNames[state.floor.speakerId] : state.turn.awaitingHuman ? 'You' : 'Unclaimed'}</strong></span><span>Epoch <strong>{state.generationEpoch}</strong></span></div>
    {providers?.relay.deliveryReason && <details className="delivery-detail"><summary>Delivery status</summary><p>{providers.relay.deliveryReason}</p></details>}
    {latestRecovery && <div className="recovery-proof"><Icon name="check" size={15}/><span>Recovered from Terse<br/><small>{state.contributions.filter(c => !!c.heardText).length} delivered contributions retained</small></span></div>}
    <div className="agent-events-heading">Recent activity <span>{entries.length}</span></div>
    <div className="agent-event-list">{entries.length ? entries.slice(0, 7).map(entry => <button className={`agent-event ${current?.id === entry.id ? 'selected' : ''}`} key={entry.id} aria-pressed={current?.id === entry.id} onClick={() => setSelected(entry.id)}><span className="event-dot"/><span><strong>{eventNames[entry.kind] ?? entry.kind}</strong><small>{pretty(entry.from)} → {pretty(entry.to)}</small></span><time>{new Date(entry.at).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' })}</time></button>) : <p className="no-agent-events">Waiting for agent messages.</p>}</div>
    {current && <details className="event-inspector" key={current.id}><summary>Inspect event <span>{current.channel}</span></summary><p>{proposal?.text ?? current.summary}</p>{proposal && <small>Proposed contribution; speech requires a floor grant.</small>}<dl><dt>Event</dt><dd>{current.kind}</dd><dt>Message</dt><dd>{current.relayMessageId ?? 'Actor / local event'}</dd>{current.latencyMs !== null && <><dt>Delivery</dt><dd>{Math.round(current.latencyMs)} ms</dd></>}</dl></details>}
  </section>
}
