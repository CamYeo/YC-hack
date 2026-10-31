import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ClientMessage, ServerMessage } from '../../shared/contracts'
import { PlaybackEngine, type PlaybackState } from '../src/audio/playback'

class FakeAudio {
  static created: FakeAudio[] = []
  src: string
  preload = ''
  paused = false
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onplaying: (() => void) | null = null
  constructor(url: string) { this.src = new URL(url, 'http://localhost').href; FakeAudio.created.push(this) }
  play() { return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
  load() {}
}
const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()
beforeEach(() => {
  FakeAudio.created = []
  const replacements = {
    Audio: FakeAudio,
    location: { href: 'http://localhost/' },
    window: { speechSynthesis: { cancel() {} }, setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms === 40000 ? 1000 : 1) },
  }
  for (const [name, value] of Object.entries(replacements)) { originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }) }
})
afterEach(() => {
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  originalDescriptors.clear()
})
const plan: Extract<ServerMessage, { type: 'speak' }> = { type: 'speak', utteranceId: 'voice-1', contributionId: 'c-1', speakerId: 'maya', generationEpoch: 4, segments: ['What if the response was lost?', 'We need a way to test that.'], voice: { mode: 'elevenlabs', segmentUrls: ['/voice/0', '/voice/1'] } }

test('sound off during pending audio finishes the same lease through captions', async () => {
  const messages: ClientMessage[] = []
  const states: PlaybackState[] = []
  const engine = new PlaybackEngine(message => messages.push(message), state => states.push(state), () => {})
  const playback = engine.play(plan)
  engine.setVoice(false)
  await playback
  expect(FakeAudio.created[0]?.paused).toBe(true)
  expect(messages.filter(m => m.type === 'playback.finished')).toEqual([{ type: 'playback.finished', utteranceId: 'voice-1', outcome: 'completed', error: null }])
  expect(messages.filter(m => m.type === 'playback.segment' && m.event === 'ended').length).toBe(2)
  expect(states.filter(s => s.playing).every(s => s.mode === 'captions')).toBe(true)
})

test('a stale server epoch does not stop newer audio, but a newer one does', async () => {
  const messages: ClientMessage[] = []
  const engine = new PlaybackEngine(message => messages.push(message), () => {}, () => {})
  const playback = engine.play(plan)
  engine.advance(3)
  expect(FakeAudio.created[0]?.paused).toBe(false)
  engine.advance(5)
  await playback
  expect(FakeAudio.created[0]?.paused).toBe(true)
  expect(messages.filter(m => m.type === 'playback.segment' && m.event === 'ended')).toEqual([])
  expect(messages.filter(m => m.type === 'playback.finished')).toEqual([{ type: 'playback.finished', utteranceId: 'voice-1', outcome: 'interrupted', error: null }])
})
