import { afterEach, expect, test } from 'bun:test'
import { CommitStrategy, RealtimeEvents, type RealtimeConnection } from '@elevenlabs/client'
import { SpeechInput, type SpeechInputDependencies } from '../src/audio/scribe'
import type { SavedRoom } from '../src/lib/api'

const room: SavedRoom = { roomId: 'test-room', roomToken: 'test-room-token', sessionId: 'test-session', resumed: false }
const credentials = { token: 'test-single-use-token', modelId: 'scribe_v2_realtime' }
const inputs: SpeechInput[] = []
afterEach(() => { for (const input of inputs.splice(0)) input.cancel(false) })

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized') }
  let reject: (error: Error) => void = () => { throw new Error('Promise not initialized') }
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
function permissionStream(log: string[], label = 'permission-track-stopped'): MediaStream {
  return { getTracks: () => [{ stop: () => log.push(label) }] } as unknown as MediaStream
}
class FakeConnection {
  listeners = new Map<string, (data: { text: string }) => void>()
  constructor(private log: string[]) {}
  on(event: string, callback: (data: { text: string }) => void) { this.listeners.set(event, callback) }
  emit(event: string, text = '') { this.listeners.get(event)?.({ text }) }
  mute() { this.log.push('mute') }
  commit() { this.log.push('commit') }
  close() { this.log.push('close'); this.emit(RealtimeEvents.CLOSE) }
}
function harness(overrides: Partial<SpeechInputDependencies> = {}, completed?: (text: string) => void) {
  const log: string[] = []
  const updates: { text: string; ready: boolean }[] = []
  const errors: string[] = []
  const connections: FakeConnection[] = []
  let tokenSignal: AbortSignal | undefined
  const sdk = {
    CommitStrategy,
    RealtimeEvents,
    Scribe: { connect: () => {
      log.push('connect')
      const connection = new FakeConnection(log)
      connections.push(connection)
      return connection as unknown as RealtimeConnection
    } },
  } as unknown as Awaited<ReturnType<SpeechInputDependencies['loadSdk']>>
  const input = new SpeechInput((text, ready) => updates.push({ text, ready }), message => errors.push(message), {
    requestMicrophone: () => { log.push('permission'); return Promise.resolve(permissionStream(log)) },
    getToken: async (_room, signal) => { log.push('token'); tokenSignal = signal; return credentials },
    loadSdk: async () => { log.push('sdk'); return sdk },
    ...overrides,
  }, completed)
  inputs.push(input)
  const connection = () => {
    const current = connections.at(-1)
    if (!current) throw new Error('No Scribe connection')
    return current
  }
  return { input, log, updates, errors, connections, connection, tokenSignal: () => tokenSignal }
}

test('microphone permission is requested in the gesture before async setup, and duplicate starts share one capture', async () => {
  const permission = deferred<MediaStream>()
  const events: string[] = []
  const h = harness({ requestMicrophone: () => { events.push('permission'); return permission.promise } })
  const starting = h.input.start(room)
  expect(events).toEqual(['permission'])
  expect(h.log).toEqual(['token', 'sdk'])
  await h.input.start(room)
  expect(events).toEqual(['permission'])
  expect(h.connections).toHaveLength(0)
  permission.resolve(permissionStream(h.log))
  await starting
  expect(h.log).toEqual(['token', 'sdk', 'permission-track-stopped', 'connect'])
  expect(h.updates).toEqual([])
  h.connection().emit(RealtimeEvents.AUDIO_STARTED)
  expect(h.updates.at(-1)).toEqual({ text: '', ready: true })
  await h.input.start(room)
  expect(h.connections).toHaveLength(1)
})

test('cancelled permission cannot revive capture or interfere with a newer microphone session', async () => {
  const pending = deferred<MediaStream>()
  let count = 0
  const stopped: string[] = []
  const h = harness({ requestMicrophone: () => ++count === 1 ? pending.promise : Promise.resolve(permissionStream(stopped, 'new-stopped')) })
  const abandoned = h.input.start(room)
  const oldTokenSignal = h.tokenSignal()
  h.input.cancel()
  expect(oldTokenSignal?.aborted).toBe(true)
  await h.input.start(room)
  h.connection().emit(RealtimeEvents.AUDIO_STARTED)
  pending.resolve(permissionStream(stopped, 'old-stopped'))
  await abandoned
  expect(stopped).toEqual(['new-stopped', 'old-stopped'])
  expect(h.connections).toHaveLength(1)
  expect(h.updates.at(-1)).toEqual({ text: '', ready: true })
  expect(h.log).not.toContain('close')
})

test('permission denial aborts token setup and gives a typed fallback without opening Scribe', async () => {
  const denied = new Error('Denied')
  denied.name = 'NotAllowedError'
  const h = harness({ requestMicrophone: () => Promise.reject(denied) })
  await expect(h.input.start(room)).rejects.toThrow('Allow the microphone for this site, or type your contribution below.')
  expect(h.tokenSignal()?.aborted).toBe(true)
  expect(h.connections).toHaveLength(0)
})

test('failed setup still releases a permission stream granted after the error', async () => {
  const permission = deferred<MediaStream>()
  const h = harness({ requestMicrophone: () => permission.promise, getToken: async () => { throw new Error('Voice service unavailable') } })
  await expect(h.input.start(room)).rejects.toThrow('Voice service unavailable')
  permission.resolve(permissionStream(h.log))
  await Promise.resolve()
  expect(h.log).toContain('permission-track-stopped')
  expect(h.connections).toHaveLength(0)
})

test('Done speaking mutes immediately, waits for the final words, then releases the microphone', async () => {
  const h = harness()
  await h.input.start(room)
  const connection = h.connection()
  connection.emit(RealtimeEvents.AUDIO_STARTED)
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'The request could be retried.')
  connection.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'We need')
  const finishing = h.input.finish()
  expect(h.log.slice(-2)).toEqual(['mute', 'commit'])
  expect(h.log).not.toContain('close')
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'We need an idempotency key.')
  expect(await finishing).toBe('The request could be retried. We need an idempotency key.')
  expect(h.log.at(-1)).toBe('close')
  expect(h.updates.at(-1)).toEqual({ text: '', ready: false })
  const count = h.updates.length
  connection.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'Stale words')
  expect(h.updates).toHaveLength(count)
  expect(h.errors).toEqual([])
})

test('cancel during final commitment closes capture and prevents a late contribution', async () => {
  const h = harness()
  await h.input.start(room)
  const connection = h.connection()
  connection.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'Abandoned thought')
  const finishing = h.input.finish()
  h.input.cancel()
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'Abandoned thought, completed late.')
  expect(await finishing).toBe('')
  expect(h.log.at(-1)).toBe('close')
  expect(h.updates.at(-1)).toEqual({ text: '', ready: false })
})


test('VAD sends a nonempty final turn once and closes capture before handoff', async () => {
  const turns: string[] = []
  const h = harness({}, text => {
    expect(h.log.at(-1)).toBe('close')
    turns.push(text)
  })
  await h.input.start(room)
  const connection = h.connection()
  connection.emit(RealtimeEvents.AUDIO_STARTED)
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, ' ')
  connection.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'What if the charge')
  expect(turns).toEqual([])
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'What if the charge succeeded?')
  expect(turns).toEqual(['What if the charge succeeded?'])
  expect(h.updates.at(-1)).toEqual({ text: turns[0], ready: false })
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'Duplicate or late speech')
  expect(turns).toHaveLength(1)
  expect(h.errors).toEqual([])
  await h.input.start(room)
  h.connection().emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'Another question.')
  expect(turns).toHaveLength(2)
})

test('manual finish and VAD cannot both submit the same turn', async () => {
  const turns: string[] = []
  const h = harness({}, text => turns.push(text))
  await h.input.start(room)
  const connection = h.connection()
  connection.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'Same key')
  const result = h.input.finish()
  connection.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'Same key for the same purchase.')
  expect(await result).toBe('Same key for the same purchase.')
  expect(turns).toEqual([])
})

test('cancellation or disconnection never auto-submits captured words', async () => {
  const turns: string[] = []
  const h = harness({}, text => turns.push(text))
  await h.input.start(room)
  const old = h.connection()
  old.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'Not ready')
  h.input.cancel()
  old.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'Not ready')
  await h.input.start(room)
  const current = h.connection()
  current.emit(RealtimeEvents.PARTIAL_TRANSCRIPT, 'Keep this draft')
  current.emit(RealtimeEvents.CLOSE)
  current.emit(RealtimeEvents.COMMITTED_TRANSCRIPT, 'Keep this draft')
  expect(turns).toEqual([])
  expect(h.updates.at(-1)).toEqual({ text: 'Keep this draft', ready: false })
})
