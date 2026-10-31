import type { ClientMessage, ServerMessage } from '../../../shared/contracts'
import type { SpeakerId } from '../../../actor/src/roomTypes'
import { PlaybackGate } from './gate'

type Speak = Extract<ServerMessage, { type: 'speak' }>
class CaptionsRequested extends Error { constructor() { super('Continue this segment with captions'); this.name = 'CaptionsRequested' } }
export interface PlaybackState { speaker: SpeakerId | null; caption: string; playing: boolean; mode: 'audio' | 'captions'; utteranceId: string | null }
export const idlePlayback: PlaybackState = { speaker: null, caption: '', playing: false, mode: 'audio', utteranceId: null }
export class PlaybackEngine {
  readonly gate = new PlaybackGate()
  private audio: HTMLAudioElement | null = null
  private preloaded: HTMLAudioElement | null = null
  private controller: AbortController | null = null
  private current: Speak | null = null
  private generation = 0
  private voice = true
  private humanSentAt: number | null = null
  private context: AudioContext | null = null
  private captionCurrent: (() => void) | null = null
  constructor(private send: (event: ClientMessage) => void, private update: (state: PlaybackState) => void, private notice: (message: string) => void, private voiceChanged: (enabled: boolean) => void = () => {}) {}
  async unlock(): Promise<void> {
    this.context ??= new AudioContext()
    if (this.context.state === 'suspended') await this.context.resume().catch(() => {})
  }
  setVoice(on: boolean): void {
    this.voice = on
    this.voiceChanged(on)
    if (!on) this.captionCurrent?.()
  }
  markHumanTurn(): void { this.humanSentAt = performance.now() }
  advance(epoch: number): void {
    this.gate.advance(epoch)
    if (this.current && !this.gate.allows(this.current.generationEpoch)) this.stop(false)
  }
  stop(localInterruption = true): void {
    const start = performance.now()
    const old = this.current
    if (localInterruption) this.gate.interrupt(old?.generationEpoch)
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.captionCurrent = null
    this.audio?.pause()
    if (this.audio) { this.audio.removeAttribute('src'); this.audio.load() }
    this.audio = null
    if (this.preloaded) { this.preloaded.pause(); this.preloaded.removeAttribute('src'); this.preloaded.load(); this.preloaded = null }
    window.speechSynthesis?.cancel()
    this.current = null
    this.update(idlePlayback)
    if (old) this.send({ type: 'playback.finished', utteranceId: old.utteranceId, outcome: 'interrupted', error: null })
    if (localInterruption) this.send({ type: 'metric', name: 'interrupt-to-silence', ms: performance.now() - start })
  }
  async play(plan: Speak): Promise<void> {
    if (!this.gate.accept(plan.utteranceId, plan.generationEpoch)) return
    if (this.current) this.stop(false)
    this.current = plan
    const generation = ++this.generation
    const controller = new AbortController()
    this.controller = controller
    const valid = () => generation === this.generation && !controller.signal.aborted && this.gate.allows(plan.generationEpoch)
    try {
      for (let index = 0; index < plan.segments.length; index++) {
        if (!valid()) return
        const text = plan.segments[index]
        if (!text) continue
        const started = () => {
          if (!valid()) return
          this.update({ speaker: plan.speakerId, caption: text, playing: true, mode: this.voice ? 'audio' : 'captions', utteranceId: plan.utteranceId })
          this.send({ type: 'playback.segment', utteranceId: plan.utteranceId, segmentIndex: index, event: 'started' })
          if (this.humanSentAt !== null && this.voice) { this.send({ type: 'metric', name: 'human-turn-to-first-audio', ms: performance.now() - this.humanSentAt }); this.humanSentAt = null }
        }
        try {
          if (!this.voice) { started(); await this.read(text, controller.signal) }
          else if (plan.voice.mode === 'elevenlabs') {
            const url = plan.voice.segmentUrls[index]
            if (!url) throw new Error('The voice response is incomplete. Continue with captions.')
            await this.playAudio(url, started, controller.signal, plan.voice.segmentUrls[index + 1])
          } else await this.speakFixture(text, plan, started, controller.signal)
        } catch (error) {
          if (!valid()) return
          if (error instanceof CaptionsRequested || error instanceof DOMException && error.name === 'NotAllowedError') {
            this.setVoice(false)
            if (!(error instanceof CaptionsRequested)) this.notice('Sound was blocked by your browser. This turn will continue with captions; use Sound on to enable audio.')
            // Start the current sentence's reading interval again; only completed segments count as delivered.
            started(); await this.read(text, controller.signal)
          } else throw error
        }
        if (!valid()) return
        this.send({ type: 'playback.segment', utteranceId: plan.utteranceId, segmentIndex: index, event: 'ended' })
      }
      if (valid()) {
        this.current = null
        this.update(idlePlayback)
        this.send({ type: 'playback.finished', utteranceId: plan.utteranceId, outcome: 'completed', error: null })
      }
    } catch (error) {
      if (!valid()) return
      const message = error instanceof Error ? error.message : 'Voice unavailable. You can continue with captions.'
      this.setVoice(false)
      if (this.preloaded) { this.preloaded.pause(); this.preloaded.removeAttribute('src'); this.preloaded.load(); this.preloaded = null }
      this.current = null
      this.update(idlePlayback)
      this.notice(message)
      this.send({ type: 'playback.finished', utteranceId: plan.utteranceId, outcome: 'failed', error: 'Voice playback failed; captions are available.' })
    }
  }
  private read(text: string, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => { const timer = window.setTimeout(resolve, Math.max(1300, text.split(/\s+/).length / 3.1 * 1000)); signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
  }
  private playAudio(url: string, started: () => void, signal: AbortSignal, nextUrl?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = this.preloaded?.src === new URL(url, location.href).href ? this.preloaded : new Audio(url)
      this.preloaded = null
      this.audio = audio
      const timeout = window.setTimeout(() => done(new Error('Voice took too long to arrive. Try resuming, or switch sound off.')), 40000)
      let finished = false
      const done = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timeout); audio.onended = null; audio.onerror = null; audio.onplaying = null; signal.removeEventListener('abort', abort); if (this.captionCurrent === captions) this.captionCurrent = null; if (error) { audio.pause(); audio.removeAttribute('src'); audio.load() }; if (this.audio === audio) this.audio = null; if (error) reject(error); else resolve() }
      const abort = () => { audio.pause(); audio.removeAttribute('src'); audio.load(); done() }
      const captions = () => {
        done(new CaptionsRequested())
        if (this.preloaded) { this.preloaded.pause(); this.preloaded.removeAttribute('src'); this.preloaded.load(); this.preloaded = null }
      }
      this.captionCurrent = captions
      signal.addEventListener('abort', abort, { once: true })
      audio.onplaying = () => {
        started(); audio.onplaying = null
        if (nextUrl && !signal.aborted) { this.preloaded = new Audio(nextUrl); this.preloaded.preload = 'auto'; this.preloaded.load() }
      }
      audio.onended = () => done()
      audio.onerror = () => done(new Error('The character’s voice could not be played. Continue with captions, or resume to try again.'))
      void audio.play().catch(error => done(error instanceof Error ? error : new Error('Sound is unavailable.')))
    })
  }
  private speakFixture(text: string, plan: Speak, started: () => void, signal: AbortSignal): Promise<void> {
    if (!window.speechSynthesis) { this.setVoice(false); started(); return this.read(text, signal) }
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)
      const hint = plan.voice.mode === 'browser' ? plan.voice.voiceHint : { pitch: 1, rate: 1, speakerId: plan.speakerId }
      const voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'))
      const offset = plan.speakerId === 'facilitator' ? 0 : plan.speakerId === 'maya' ? 1 : 2
      utterance.voice = voices[offset % Math.max(1, voices.length)] ?? null
      utterance.pitch = hint.pitch; utterance.rate = hint.rate
      let finished = false
      const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort); utterance.onstart = null; utterance.onend = null; utterance.onerror = null; if (this.captionCurrent === captions) this.captionCurrent = null; if (error) reject(error); else resolve() }
      const abort = () => { speechSynthesis.cancel(); finish() }
      const captions = () => { finish(new CaptionsRequested()); speechSynthesis.cancel() }
      this.captionCurrent = captions
      const timer = window.setTimeout(() => { speechSynthesis.cancel(); finish(new Error('Browser fixture speech did not finish. Future turns will use captions.')) }, (text.split(/\s+/).length / 2 + 4) * 1000)
      signal.addEventListener('abort', abort, { once: true })
      utterance.onstart = started; utterance.onend = () => finish()
      utterance.onerror = () => finish(new Error('Browser fixture voice unavailable. Future turns will use captions.'))
      speechSynthesis.speak(utterance)
    })
  }
  dispose(): void { this.stop(false); void this.context?.close(); this.context = null }
}
