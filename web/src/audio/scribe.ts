import type { RealtimeConnection } from '@elevenlabs/client'
import { getScribeToken, type SavedRoom } from '../lib/api'

type ScribeModule = Pick<typeof import('@elevenlabs/client'), 'Scribe' | 'CommitStrategy' | 'RealtimeEvents'>
export interface SpeechInputDependencies {
  requestMicrophone: () => Promise<MediaStream>
  getToken: typeof getScribeToken
  loadSdk: () => Promise<ScribeModule>
}
const defaults: SpeechInputDependencies = {
  requestMicrophone: () => {
    if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('Microphone access is unavailable in this browser. You can type your contribution.'))
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
  },
  getToken: getScribeToken,
  loadSdk: () => import('@elevenlabs/client'),
}
function microphoneError(error: unknown): Error {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return new Error('Microphone permission was denied. Allow the microphone for this site, or type your contribution below.')
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return new Error('No microphone was found. Connect a microphone or type your contribution below.')
  if (name === 'NotReadableError' || name === 'TrackStartError') return new Error('Your microphone is unavailable. Check whether another app is using it, or type your contribution below.')
  return error instanceof Error ? error : new Error('Microphone unavailable. You can type your contribution below.')
}

export class SpeechInput {
  private connection: RealtimeConnection | null = null
  private committed: string[] = []
  private partial = ''
  private epoch = 0
  private starting = false
  private finishing = false
  private settle: (() => void) | null = null
  private tokenRequest: AbortController | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly dependencies: SpeechInputDependencies
  constructor(private update: (text: string, ready: boolean) => void, private error: (message: string) => void, dependencies: Partial<SpeechInputDependencies> = {}, private completed?: (text: string) => void) {
    this.dependencies = { ...defaults, ...dependencies }
  }
  private transcript(): string { return [...this.committed, this.partial].join(' ').trim() }
  private clearReadyTimer(): void { if (this.readyTimer !== null) clearTimeout(this.readyTimer); this.readyTimer = null }
  async start(room: SavedRoom): Promise<void> {
    // A double click must not reopen permission or replace a live capture.
    if (this.starting || this.connection) return
    this.cancel(false)
    const epoch = ++this.epoch
    this.starting = true
    const abort = new AbortController()
    this.tokenRequest = abort
    try {
      // This call runs synchronously in the click/key gesture, before any await.
      // Scribe's public microphone API owns its own stream, so release this permission
      // stream immediately, including when permission resolves after cancellation.
      const permission = this.dependencies.requestMicrophone().then(stream => {
        for (const track of stream.getTracks()) track.stop()
      })
      const token = this.dependencies.getToken(room, AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]))
      const [_, credentials, { Scribe, CommitStrategy, RealtimeEvents }] = await Promise.all([permission, token, this.dependencies.loadSdk()])
      if (epoch !== this.epoch) return
      const connection = Scribe.connect({
        token: credentials.token, modelId: credentials.modelId, commitStrategy: CommitStrategy.VAD,
        vadSilenceThresholdSecs: 1.5,
        microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, workletPaths: { scribeAudioProcessor: '/worklets/scribeAudioProcessor.js' } },
      })
      this.connection = connection
      const current = () => this.connection === connection && epoch === this.epoch
      const fail = (message: string) => {
        if (!current()) return
        const text = this.transcript()
        this.cancel(false)
        this.update(text, false)
        this.error(message)
      }
      this.readyTimer = setTimeout(() => fail('The microphone could not connect to ElevenLabs. Try again or type your contribution below.'), 20000)
      connection.on(RealtimeEvents.AUDIO_STARTED, () => { if (current()) { this.clearReadyTimer(); this.update('', true) } })
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, data => {
        if (!current()) return
        this.partial = data.text
        this.update(this.transcript(), true)
      })
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, data => {
        if (!current()) return
        if (data.text.trim()) this.committed.push(data.text.trim())
        this.partial = ''
        this.update(this.transcript(), true)
        this.settle?.()
        // VAD commits only after the configured silence window. Close capture
        // before handing over so the agents' audio cannot enter this turn.
        if (!this.finishing && data.text.trim() && this.completed) {
          const text = this.transcript()
          this.cancel(false)
          this.update(text, false)
          this.completed(text)
        }
      })
      connection.on(RealtimeEvents.ERROR, () => fail('The microphone could not connect to ElevenLabs. You can type your contribution below.'))
      connection.on(RealtimeEvents.CLOSE, () => {
        if (!current()) return
        this.clearReadyTimer()
        this.connection = null
        this.settle?.()
        this.update(this.transcript(), false)
        if (!this.finishing) this.error('The microphone disconnected. Your captured text is available below; you can type or reconnect.')
      })
    } catch (error) {
      if (epoch !== this.epoch) return
      this.cancel(false)
      throw microphoneError(error)
    } finally {
      if (this.tokenRequest === abort) this.tokenRequest = null
      if (epoch === this.epoch) this.starting = false
    }
  }
  async finish(): Promise<string> {
    const epoch = this.epoch
    const connection = this.connection
    this.finishing = true
    if (connection) {
      // Stop real microphone input immediately while the last transcript commits.
      // close() below then releases the SDK's tracks and audio context.
      try { connection.mute() } catch {
        const text = this.transcript()
        this.cancel()
        return text
      }
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.settle = null; resolve() }, 1600)
        this.settle = () => { clearTimeout(timer); this.settle = null; resolve() }
        try { connection.commit() } catch { clearTimeout(timer); this.settle = null; resolve() }
      })
    }
    if (epoch !== this.epoch) return ''
    const text = this.transcript()
    this.cancel()
    return text
  }
  cancel(notify = true): void {
    this.epoch++
    this.starting = false
    this.finishing = false
    this.clearReadyTimer()
    this.tokenRequest?.abort(); this.tokenRequest = null
    const connection = this.connection; this.connection = null
    connection?.close(); this.settle?.(); this.settle = null
    this.committed = []; this.partial = ''
    if (notify) this.update('', false)
  }
}
