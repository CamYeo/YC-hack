import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconButton, SegmentedControl, Theme, Tooltip } from '@radix-ui/themes'
import type { ProviderStatus, CreateRoomRequest } from '../../../shared/contracts'
import type { AddressedTo } from '../../../actor/src/roomTypes'
import type { TopicsResponse } from '../../../shared/topic'
import { type SavedRoom } from '../lib/api'
import { useRoom } from '../lib/useRoom'
import { useSeminarTheme } from '../lib/theme'
import { LiveCoordination } from './LiveCoordination'
import { Pumpkin } from './Illustrations'
import { SeminarScene } from './SeminarScene'
import './seminar-scene.css'
import { SpeechInput } from '../audio/scribe'
import { Icon } from './Icon'
import { Providers } from './Providers'
import { DiscussionPanels, EvidencePanel, ReflectionView } from './DiscussionPanels'

export function Room({ room, status, topics, leave, again }: { room: SavedRoom; status: ProviderStatus | null; topics: TopicsResponse | null; leave: () => void; again: (input: CreateRoomRequest) => void }) {
  const { theme, names, shortNames } = useSeminarTheme()
  const { state, providers, connected, notice, setNotice, thinking, playback, metrics, engine, voice, send } = useRoom(room, status)
  const [draft, setDraft] = useState('')
  const [addressedTo, setAddressedTo] = useState<AddressedTo>('group')
  const [captions, setCaptions] = useState(true)
  const [view, setView] = useState<'reasoning' | 'transcript' | 'agents'>('agents')
  const [micState, setMicState] = useState<'off' | 'connecting' | 'listening' | 'finishing'>('off')
  const [micText, setMicText] = useState('')
  const [review, setReview] = useState(false)
  const [traceFilter, setTraceFilter] = useState('all')
  const [elapsed, setElapsed] = useState(0)
  const composer = useRef<HTMLTextAreaElement>(null)
  const micGeneration = useRef(0)
  const micActive = useRef(false)
  const finishingMic = useRef(false)
  const autoSubmit = useRef<(text: string) => void>(() => {})
  // The constructor stores this callback; the microphone invokes it only after render.
  // eslint-disable-next-line react-hooks/refs
  const [speech] = useState(() => new SpeechInput((text, ready) => {
    setMicText(text)
    if (!finishingMic.current) {
      micActive.current = ready
      setMicState(ready ? 'listening' : 'off')
      if (!ready && text) setDraft(text)
    }
  }, message => { setNotice(message); composer.current?.focus() }, {}, text => autoSubmit.current(text)))
  const cancelMic = useCallback(() => { micGeneration.current++; micActive.current = false; finishingMic.current = false; speech.cancel(); setMicState('off') }, [speech])
  const topic = topics?.topics.find(item => item.id === state?.config?.topicId)
  const activeContribution = state?.contributions.find(c => c.utteranceId === playback.utteranceId)
  const jumpIn = useCallback(() => {
    if (!connected || state?.phase !== 'discussion' || micActive.current) return
    const generation = ++micGeneration.current
    micActive.current = true
    finishingMic.current = false
    engine.stop(true)
    if (!send({ type: 'human.jumpIn', source: 'button' })) {
      micActive.current = false
      setNotice('The room is reconnecting. Try the microphone again once connected.')
      composer.current?.focus()
      return
    }
    setNotice(null)
    setMicText('')
    setMicState('connecting')
    // Keep this call in the original click/key gesture so permission opens immediately.
    void speech.start(room).catch(error => {
      if (generation !== micGeneration.current) return
      micActive.current = false
      setMicState('off')
      setNotice(error instanceof Error ? error.message : 'Microphone unavailable. You can type your contribution instead.')
      composer.current?.focus()
    })
  }, [connected, state?.phase, engine, send, room, speech, setNotice])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, a, [role="button"], [role="tab"], [role="switch"]') || target?.isContentEditable || event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.code === 'Space' || event.key.toLowerCase() === 'j') && connected && state?.phase === 'discussion' && !event.repeat) { event.preventDefault(); jumpIn() }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [jumpIn, state?.phase, connected])
  // Stop the external capture when the room disconnects or leaves discussion.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (!connected || state?.phase !== 'discussion') cancelMic() }, [connected, state?.phase, cancelMic])
  useEffect(() => () => { micGeneration.current++; micActive.current = false; finishingMic.current = false; speech.cancel(false) }, [speech])
  useEffect(() => {
    if (!state?.budget.startedAt) return
    const started = state.budget.startedAt
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer)
  }, [state?.budget.startedAt])
  const roomTheme = state?.config ? state.config.theme ?? 'classroom' : null
  useEffect(() => {
    if (connected && roomTheme && roomTheme !== theme) {
      send({ type: 'session.theme', theme })
      engine.stop(true)
    }
  }, [connected, roomTheme, theme, send, engine])
  const say = (text: string, inputMode: 'voice' | 'text') => {
    const normalized = text.trim()
    if (!normalized || !connected || state?.phase !== 'discussion') return
    engine.stop(true)
    send({ type: 'human.jumpIn', source: 'button' })
    engine.markHumanTurn()
    const sent = send({ type: 'human.contribution', eventId: crypto.randomUUID(), text: normalized.slice(0, 2000), inputMode, addressedTo, replyToContributionId: activeContribution?.id ?? null })
    if (sent) { setDraft(''); cancelMic(); setMicText('') }
  }
  useEffect(() => {
    autoSubmit.current = text => {
      setDraft(text)
      say(text, 'voice')
    }
  })
  const doneSpeaking = async () => {
    if (!micActive.current || finishingMic.current) return
    finishingMic.current = true
    const generation = micGeneration.current
    setMicState('finishing')
    const text = await speech.finish()
    if (generation !== micGeneration.current) return
    finishingMic.current = false
    micActive.current = false
    setMicState('off')
    if (text) say(text, 'voice')
    else { setNotice('No speech was captured. Try the microphone again, or type your thought.'); composer.current?.focus() }
  }
  const pause = () => { engine.stop(true); cancelMic(); send({ type: 'session.pause' }) }
  const resume = () => { setNotice(null); void engine.unlock(); send({ type: 'session.resume' }) }
  const end = () => { engine.stop(true); cancelMic(); send({ type: 'session.end' }) }
  const leaveRoom = () => { engine.stop(true); cancelMic(); if (state?.phase === 'discussion') send({ type: 'session.pause' }); leave() }
  const isPaused = state?.phase === 'paused'
  const isEnded = state?.phase === 'ended' || state?.phase === 'reflection'
  const fixture = providers?.reasoning.mode === 'fixture'
  const soundLabel = !voice || playback.mode === 'captions' ? 'Captions only' : providers?.voice.mode === 'fixture' ? 'Browser fixture voice' : providers?.voice.mode === 'live' ? 'ElevenLabs voices' : 'Voice unavailable'
  if (!state) return <main className="room-loading"><span className="large-star">✦</span><h1>Opening seminar</h1><p>{connected ? 'Loading room…' : 'Connecting to your seminar…'}</p>{notice && <p className="error-text">{notice}</p>}<Button radius="full" variant="soft" size="2" className="button secondary" onClick={leaveRoom}>Back to the lobby</Button></main>
  if (state.reflection && !review) return <main className={`room-page room-${theme}`}><ReflectionView reflection={state.reflection} contributions={state.contributions} fresh={leaveRoom} returnToRoom={id => { setReview(true); if (id) { setView('transcript'); setTimeout(() => document.getElementById(`contribution-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50) } }}/><div className="same-topic"><Button radius="full" variant="ghost" size="1" className="text-button" onClick={() => { if (state.config) again({ topicId: state.config.topicId, category: state.config.category, format: 'socratic', theme, difficulty: state.config.difficulty, participation: state.config.participation, customQuestion: state.config.customQuestion, reading: state.config.reading }) }}>Restart this topic <Icon name="arrow" size={14}/></Button></div></main>
  return <main className={`room-page room-${theme}`}>
    <section className="room-heading"><div><div className="eyebrow">{theme === 'halloween' && <Pumpkin size={23}/>}Socratic seminar <span className="eyebrow-divider">/</span> {state.config?.topicTitle}</div><h1>{state.config?.openingQuestion}</h1></div><div className="room-heading-actions"><span className="session-clock">{Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}</span><Button radius="full" variant="ghost" size="1" className="text-button" onClick={leaveRoom}>Leave room <Icon name="arrow" size={14}/></Button></div></section>
    {(notice || !connected || fixture) && <div className={`notice-bar ${!connected ? 'connection-lost' : ''}`} role={notice || !connected ? 'status' : undefined}><span>{!connected ? 'Reconnecting to the room. Playback is stopped.' : notice ?? 'Rehearsal mode: dialogue comes from labelled fixture lines, not live OpenAI reasoning.'}</span>{notice && connected && <Tooltip content="Dismiss notice"><IconButton radius="full" variant="ghost" size="1" className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="close" size={15}/></IconButton></Tooltip>}</div>}
    <div className="seminar-layout"><section className="table-column" aria-label="Seminar table">
      <SeminarScene speaker={playback.speaker} playing={playback.playing} reading={playback.mode === 'captions'} thinking={thinking} paused={isPaused} ended={isEnded} listening={micState === 'listening'} awaitingHuman={state.turn.awaitingHuman}>
        {captions && !isPaused && (playback.caption || micText || thinking.length > 0 || isEnded) && <div className={`live-caption ${playback.playing || micText ? 'has-speech' : ''}`} aria-live="polite" aria-atomic="true"><div className="caption-speaker">{micState === 'listening' || micState === 'connecting' ? <><span className="status-dot"/> {micState === 'connecting' ? 'Connecting your microphone' : 'You · voice input'}</> : playback.speaker ? <>{shortNames[playback.speaker]} {activeContribution?.addressedTo && activeContribution.addressedTo !== 'group' ? `→ ${shortNames[activeContribution.addressedTo]}` : '→ the table'}</> : thinking.length > 0 ? `${thinking.map(id => shortNames[id]).join(' & ')} ${thinking.length > 1 ? 'are' : 'is'} preparing a response…` : state.turn.awaitingHuman ? 'Your turn' : isEnded ? 'Session complete' : 'Waiting for a contribution'}</div><p>{micText || playback.caption || (isEnded ? 'You can review the transcript or reflection.' : state.turn.awaitingHuman ? 'Type or use the microphone.' : 'Jump in to speak, or listen.')}</p></div>}
        {isPaused && <div className="pause-overlay"><span className="eyebrow">Paused</span><h2>Seminar paused</h2><p>{state.pauseReason === 'relay-failure' ? 'Agent Relay disconnected. Resume to retry the conversation.' : 'Your conversation and reasoning notes are saved.'}</p><Button radius="full" variant="solid" size="2" className="button primary" onClick={resume} disabled={!connected}><Icon name="play" size={16}/> Resume seminar</Button></div>}
        {state.phase === 'reflection' && !state.reflection && <div className="pause-overlay"><span className="loader"/><h2>Preparing reflection</h2><p>Based on the recorded discussion.</p></div>}
      </SeminarScene>
      <div className="human-place">
      <div className="control-dock"><div className="your-seat"><span className={`your-avatar ${micState === 'listening' ? 'mic-active' : ''}`}>You</span><div><strong>{state.turn.awaitingHuman ? 'Your turn' : 'You'}</strong><small>{soundLabel}</small></div></div><div className="call-controls"><Button radius="full" variant="solid" size="2" className="button primary" onClick={jumpIn} disabled={!connected || isPaused || isEnded || micState !== 'off'} aria-label="Jump in and start microphone">Jump in <span className="key-hint">J</span></Button><Tooltip content={isPaused ? 'Resume seminar' : 'Pause seminar'}><IconButton radius="full" variant="soft" size="2" className="icon-button control-icon" onClick={isPaused ? resume : pause} disabled={!connected || isEnded} aria-label={isPaused ? 'Resume seminar' : 'Pause seminar'}><Icon name={isPaused ? 'play' : 'pause'}/></IconButton></Tooltip><Tooltip content={voice ? 'Turn sound off' : 'Turn sound on'}><IconButton radius="full" variant="soft" size="2" className="icon-button control-icon" aria-pressed={voice} aria-label={voice ? 'Turn sound off' : 'Turn sound on'} onClick={() => { const next = !voice; engine.setVoice(next); if (next) void engine.unlock() }}><Icon name={voice ? 'sound' : 'mute'}/></IconButton></Tooltip><Tooltip content={captions ? 'Hide captions' : 'Show captions'}><IconButton radius="full" variant="soft" size="2" className="icon-button control-icon captions-button" aria-label={captions ? 'Hide captions' : 'Show captions'} aria-pressed={captions} onClick={() => setCaptions(!captions)}>CC</IconButton></Tooltip></div></div>
      {!isEnded && <form className={`composer ${micState !== 'off' ? 'is-recording' : ''}`} onSubmit={event => { event.preventDefault(); say(draft, 'text') }}><div className="composer-top"><label htmlFor="your-thought">{micState === 'off' ? 'Your contribution' : micState === 'finishing' ? 'Finishing your transcript…' : micState === 'connecting' ? 'Connecting microphone…' : 'Listening to you…'}</label><label className="address-picker"><span className="sr-only">Address your contribution to</span><select value={addressedTo} onChange={e => setAddressedTo(e.target.value as AddressedTo)}><option value="group">To the table</option><option value="maya">To {shortNames.maya}</option><option value="theo">To {shortNames.theo}</option></select></label></div><textarea ref={composer} id="your-thought" value={micState === 'off' ? draft : micText} readOnly={micState !== 'off'} disabled={!connected || isPaused} placeholder="Type a question or response…" onChange={e => setDraft(e.target.value)} rows={2} maxLength={2000} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && micState === 'off') { e.preventDefault(); say(draft, 'text') } }}/><div className="composer-actions"><div className="composer-left">{micState === 'off' ? <Button radius="full" variant="ghost" size="1" className="text-button mic-button" type="button" onClick={jumpIn} disabled={!connected || isPaused}><Icon name="mic" size={16}/> Use microphone</Button> : <Button radius="full" variant="ghost" size="1" className="text-button" type="button" onClick={() => { const text = micText; cancelMic(); setDraft(text) }}>Cancel microphone</Button>}<span className="composer-hint">{micState === 'off' ? 'Enter to send · Shift + Enter for a new line' : 'Pause for a moment to send automatically.'}</span></div>{micState === 'off' ? <Tooltip content="Send contribution"><IconButton radius="full" variant="solid" size="2" type="submit" className="button send-button" disabled={!draft.trim() || !connected || isPaused} aria-label="Send your contribution"><Icon name="arrow" size={18}/></IconButton></Tooltip> : <Button radius="full" variant="solid" size="2" type="button" className="button primary done-speaking" disabled={micState !== 'listening'} onClick={() => void doneSpeaking()}>Done speaking <Icon name="check" size={16}/></Button>}</div></form>}
      </div>
      <div className="under-table"><span>{state.turn.awaitingHuman && !isEnded ? <Button radius="full" variant="ghost" size="1" className="text-button" onClick={() => { cancelMic(); send({ type: 'human.pass' }) }} disabled={!connected || isPaused}>Keep listening <Icon name="arrow" size={14}/></Button> : null}</span>{!isEnded ? <Button radius="full" variant="ghost" size="1" className="text-button" onClick={end} disabled={!connected}>End & reflect</Button> : state.reflection ? <Button radius="full" variant="ghost" size="1" className="text-button" onClick={() => setReview(false)}>View reflection <Icon name="arrow" size={14}/></Button> : null}</div>
    </section><Theme appearance="light" accentColor="orange" grayColor="sand" hasBackground={false} asChild><div className="seminar-notebook"><SegmentedControl.Root className="side-panel-tabs" radius="full" value={view} aria-label="Seminar sidebar" onValueChange={value => { if (value === 'reasoning' || value === 'transcript' || value === 'agents') setView(value) }}><SegmentedControl.Item value="reasoning">Notes</SegmentedControl.Item><SegmentedControl.Item value="transcript">Transcript</SegmentedControl.Item><SegmentedControl.Item value="agents">Agents</SegmentedControl.Item></SegmentedControl.Root>{view === 'agents' ? <LiveCoordination state={state} providers={providers} connected={connected}/> : <DiscussionPanels state={state} topic={topic} send={send} view={view} setView={setView} minimal/>}</div></Theme></div>
    <EvidencePanel state={state} topic={topic} send={send} disabled={!connected || isPaused || isEnded}/>
    <details className="behind-discussion"><summary><span><Icon name="settings" size={16}/> Behind the discussion</span><span className="muted small">Room state, agent exchanges & connections</span></summary><div className="behind-inner"><Providers status={providers}/><div className="technical-stats"><span>Room version <strong>{state.version}</strong></span><span>Cancellation epoch <strong>{state.generationEpoch}</strong></span><span>Floor <strong>{state.floor ? names[state.floor.speakerId] : 'Open'}</strong></span>{Object.entries(metrics).map(([key, ms]) => <span key={key}>{key.replaceAll('-', ' ')} <strong>{Math.round(ms)} ms</strong></span>)}</div><div className="trace-heading"><h3>Agent exchange trace</h3><label className="sr-only" htmlFor="trace-filter">Filter exchanges</label><select id="trace-filter" value={traceFilter} onChange={e => setTraceFilter(e.target.value)}><option value="all">All connections</option><option value="relay">Agent Relay</option><option value="terse">Terse</option><option value="openai">OpenAI</option><option value="elevenlabs">ElevenLabs</option></select></div><div className="trace-list">{state.trace.filter(t => traceFilter === 'all' || t.channel === traceFilter).slice(-60).reverse().map(item => <article key={item.id}><time>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span className={`trace-channel channel-${item.channel}`}>{item.channel}</span><div><strong>{item.from} → {item.to} · {item.kind}</strong><p>{item.summary}</p>{item.relayMessageId && <code>Relay message {item.relayMessageId}</code>}{item.latencyMs !== null && <span className="trace-latency">{Math.round(item.latencyMs)} ms</span>}</div></article>)}{state.trace.length === 0 && <p className="muted">Exchanges will appear as agents communicate.</p>}</div></div></details>
  </main>
}
