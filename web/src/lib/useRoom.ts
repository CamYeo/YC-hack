import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, ProviderStatus, ServerMessage } from '../../../shared/contracts'
import type { PublicRoomState, SpeakerId } from '../../../actor/src/roomTypes'
import type { SavedRoom } from './api'
import { PlaybackEngine, idlePlayback } from '../audio/playback'

type Incoming = ServerMessage | { type: 'snapshot'; state: PublicRoomState }
export function useRoom(room: SavedRoom, initialStatus: ProviderStatus | null) {
  const [state, setState] = useState<PublicRoomState | null>(null)
  const [providers, setProviders] = useState(initialStatus)
  const [connected, setConnected] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [thinking, setThinking] = useState<SpeakerId[]>([])
  const [playback, setPlayback] = useState(idlePlayback)
  const [voice, setVoice] = useState(true)
  const [metrics, setMetrics] = useState<Record<string, number>>({})
  const socketRef = useRef<WebSocket | null>(null)
  const snapshotRef = useRef<PublicRoomState | null>(null)
  const canPlay = useRef(!room.resumed)
  const resumeRequested = useRef(false)
  const send = useCallback((message: ClientMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false
    if (message.type === 'session.resume') resumeRequested.current = true
    if (message.type === 'session.pause' || message.type === 'session.end') { canPlay.current = false; resumeRequested.current = false }
    socketRef.current.send(JSON.stringify(message))
    return true
  }, [])
  // The engine stores send; it reads the socket ref only during playback events.
  // eslint-disable-next-line react-hooks/refs
  const [engine] = useState(() => new PlaybackEngine(send, setPlayback, setNotice, setVoice))
  useEffect(() => {
    let stopped = false
    let attempts = 0
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let hasConnected = room.resumed
    const connect = () => {
      if (stopped) return
      const url = new URL('/ws', window.location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('roomId', room.roomId)
      url.searchParams.set('roomToken', room.roomToken)
      const socket = new WebSocket(url)
      socketRef.current = socket
      socket.onopen = () => { if (stopped || socketRef.current !== socket) return; setConnected(true); attempts = 0; send({ type: 'hello', clientId: crypto.randomUUID(), resume: hasConnected }); hasConnected = true }
      socket.onmessage = event => {
        if (stopped || socketRef.current !== socket) return
        let message: Incoming
        try { message = JSON.parse(String(event.data)) as Incoming } catch { return }
        switch (message.type) {
          case 'snapshot': {
            const next = message.state
            const previous = snapshotRef.current
            if (previous && (next.version < previous.version || next.version === previous.version && next.updatedAt < previous.updatedAt)) return
            snapshotRef.current = next
            engine.advance(next.generationEpoch)
            if (next.phase !== 'discussion') { canPlay.current = false; engine.stop(false); setThinking([]) }
            else if (resumeRequested.current) { canPlay.current = true; resumeRequested.current = false }
            setState(next)
            break
          }
          case 'welcome': setProviders(message.providers); break
          case 'providers': setProviders(message.providers); break
          case 'speak': if (canPlay.current) { setThinking([]); void engine.play(message) }; break
          case 'stop': engine.advance(message.generationEpoch); setThinking([]); break
          case 'thinking': setThinking(message.speakerIds); break
          case 'notice': setNotice(message.text); break
          case 'metric': setMetrics(current => ({ ...current, [message.name]: message.ms })); break
        }
      }
      socket.onclose = event => {
        if (stopped || socketRef.current !== socket) return
        canPlay.current = false; resumeRequested.current = false
        setConnected(false); setThinking([]); engine.stop(false)
        if (event.code === 4000) { setNotice('This room was opened in another tab. Close this tab to avoid two people controlling the same seat.'); return }
        if (event.code === 4001 || event.code === 1008) { setNotice('This saved room is unavailable. Return to the lobby to start a fresh room.'); return }
        reconnect = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 8000))
      }
      socket.onerror = () => { if (!stopped && socketRef.current === socket) setNotice('The room connection was interrupted. Reconnecting…') }
    }
    connect()
    const visibility = () => { send({ type: 'client.visibility', hidden: document.hidden }) }
    document.addEventListener('visibilitychange', visibility)
    return () => { stopped = true; clearTimeout(reconnect); document.removeEventListener('visibilitychange', visibility); engine.dispose(); socketRef.current?.close(); socketRef.current = null }
  }, [engine, room.roomId, room.roomToken, room.resumed, send])
  return { state, providers, connected, notice, setNotice, thinking, playback, metrics, engine, voice, send }
}
