import { createHash } from "node:crypto"
import { chmod, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Exact provider input; credentials and room identity deliberately never enter this descriptor. */
export interface SpeechRequest {
    voiceId: string
    modelId: string
    outputFormat: string
    voiceSettings: Record<string, unknown>
    text: string
}
export interface SpeechCacheOptions {
    directory: string
    generate: (request: SpeechRequest, signal: AbortSignal) => Promise<Response>
    limits?: { maxDiskBytes?: number; maxFiles?: number; maxEntryBytes?: number; maxPending?: number }
}
export interface SpeechResponseOptions {
    signal?: AbortSignal
    /** Authorization happens at the route; this additionally checks the current speech lease. */
    isCurrent?: () => Promise<boolean>
}
export class SpeechCacheError extends Error {
    constructor(readonly code: "STALE" | "AUDIO_LIMIT" | "AUDIO_BUSY" | "AUDIO_INVALID" | "AUDIO_CLOSED", message: string, readonly status: number) { super(message); this.name = "SpeechCacheError" }
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}
export function speechCacheKey(request: SpeechRequest): string {
    return createHash("sha256").update(canonical({ version: 1, voiceId: request.voiceId, modelId: request.modelId, outputFormat: request.outputFormat, voiceSettings: request.voiceSettings, text: request.text })).digest("hex")
}
function abortError(): DOMException { return new DOMException("Speech request cancelled", "AbortError") }
function deferred() {
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => {})
    return { promise, resolve, reject }
}
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(abortError())
    return new Promise<T>((resolve, reject) => {
        const aborted = () => { cleanup(); reject(abortError()) }
        const cleanup = () => signal.removeEventListener("abort", aborted)
        signal.addEventListener("abort", aborted, { once: true })
        void promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
}
interface FileEntry { bytes: number; accessed: number }
interface Generation {
    key: string
    abort: AbortController
    chunks: Uint8Array[]
    bytes: number
    users: number
    finished: boolean
    error: unknown
    changed: Set<() => void>
    ready: ReturnType<typeof deferred>
    done: ReturnType<typeof deferred>
}
const mp3 = (bytes: Uint8Array) => bytes.length >= 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))

/** Persistent MP3 reuse, plus one fan-out generation per exact voice/model/settings/text. */
export function createSpeechCache(options: SpeechCacheOptions) {
    const limits = { maxDiskBytes: 128 * 1024 * 1024, maxFiles: 500, maxEntryBytes: 8 * 1024 * 1024, maxPending: 8, ...options.limits }
    const files = new Map<string, FileEntry>()
    const pending = new Map<string, Generation>()
    let diskBytes = 0
    let closed = false
    let diskQueue: Promise<void> = Promise.resolve()
    const path = (key: string) => join(options.directory, `${key}.mp3`)
    const serializeDisk = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = diskQueue.then(operation)
        diskQueue = result.then(() => {}, () => {})
        return result
    }
    const evict = async () => {
        const ordered = [...files.entries()].sort(([, a], [, b]) => a.accessed - b.accessed)
        for (const [key, entry] of ordered) {
            if (files.size <= limits.maxFiles && diskBytes <= limits.maxDiskBytes) break
            await rm(path(key), { force: true })
            files.delete(key); diskBytes -= entry.bytes
        }
    }
    const initialized = (async () => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 }); await chmod(options.directory, 0o700)
        for (const filename of await readdir(options.directory)) {
            const match = /^([a-f0-9]{64})\.mp3$/.exec(filename)
            if (!match?.[1]) {
                // Clean crash leftovers without touching a concurrently running warmer's write.
                if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(filename)) {
                    const info = await stat(join(options.directory, filename)).catch(() => null)
                    if (info && Date.now() - info.mtimeMs > 60 * 60 * 1000) await rm(join(options.directory, filename), { force: true })
                }
                continue
            }
            const info = await stat(join(options.directory, filename)).catch(() => null)
            if (!info?.isFile()) continue
            if (info.size > limits.maxEntryBytes || info.size === 0) { await rm(join(options.directory, filename), { force: true }); continue }
            files.set(match[1], { bytes: info.size, accessed: info.mtimeMs }); diskBytes += info.size
        }
        await evict()
    })()
    void initialized.catch(() => {})
    const readCached = async (key: string): Promise<Uint8Array | null> => {
        await initialized
        return serializeDisk(async () => {
            let entry = files.get(key)
            // A separate warm-cache command can add files while the server keeps running.
            if (!entry) {
                const info = await stat(path(key)).catch(() => null)
                if (info?.isFile() && info.size > 0 && info.size <= limits.maxEntryBytes) {
                    files.set(key, { bytes: info.size, accessed: info.mtimeMs }); diskBytes += info.size
                    await evict(); entry = files.get(key)
                }
            }
            if (!entry) return null
            const bytes = await readFile(path(key)).catch(() => null)
            if (!bytes || bytes.length > limits.maxEntryBytes || !mp3(bytes)) {
                await rm(path(key), { force: true }); files.delete(key); diskBytes -= entry.bytes
                return null
            }
            diskBytes += bytes.length - entry.bytes; entry.bytes = bytes.length
            entry.accessed = Date.now()
            await utimes(path(key), new Date(), new Date(entry.accessed))
            return new Uint8Array(bytes)
        })
    }
    const save = async (job: Generation) => {
        await initialized
        await serializeDisk(async () => {
            if (job.abort.signal.aborted) throw abortError()
            const bytes = new Uint8Array(job.bytes)
            let offset = 0
            for (const chunk of job.chunks) { bytes.set(chunk, offset); offset += chunk.length }
            if (!mp3(bytes)) throw new SpeechCacheError("AUDIO_INVALID", "The speech provider returned invalid MP3 audio", 502)
            const temporary = join(options.directory, `${job.key}.${crypto.randomUUID()}.tmp`)
            try {
                await writeFile(temporary, bytes, { mode: 0o600 })
                if (job.abort.signal.aborted) throw abortError()
                await rename(temporary, path(job.key))
                const previous = files.get(job.key)
                if (previous) diskBytes -= previous.bytes
                files.set(job.key, { bytes: bytes.length, accessed: Date.now() }); diskBytes += bytes.length
                await evict()
            } finally { await rm(temporary, { force: true }) }
        })
    }
    const notify = (job: Generation) => { for (const callback of job.changed) callback(); job.changed.clear() }
    const begin = (request: SpeechRequest, key: string): Generation => {
        if (pending.size >= limits.maxPending) throw new SpeechCacheError("AUDIO_BUSY", "Speech generation is busy; retry shortly", 503)
        const job: Generation = { key, abort: new AbortController(), chunks: [], bytes: 0, users: 0, finished: false, error: null, changed: new Set(), ready: deferred(), done: deferred() }
        pending.set(key, job)
        void (async () => {
            let reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } | null = null
            const cancel = () => { void reader?.cancel().catch(() => {}) }
            try {
                const response = await options.generate(request, job.abort.signal)
                if (job.abort.signal.aborted) throw abortError()
                if (!response.ok || !response.body || !/^(audio\/mpeg|audio\/mp3|application\/octet-stream)(;|$)/i.test(response.headers.get("content-type") ?? "")) {
                    await response.body?.cancel()
                    throw new SpeechCacheError("AUDIO_INVALID", "The speech provider did not return MP3 audio", 502)
                }
                const source = response.body.getReader(); reader = source
                job.abort.signal.addEventListener("abort", cancel, { once: true })
                // Hold only until the first valid MP3 bytes, never the complete utterance.
                const prefix: Uint8Array[] = []
                let prefixBytes = 0
                for (;;) {
                    const chunk = await source.read()
                    if (job.abort.signal.aborted) throw abortError()
                    if (chunk.done) break
                    if (!chunk.value.length) continue
                    job.bytes += chunk.value.length
                    if (job.bytes > limits.maxEntryBytes) throw new SpeechCacheError("AUDIO_LIMIT", "Speech segment exceeds the audio cache limit", 502)
                    if (!job.chunks.length && prefixBytes < 3) {
                        prefix.push(chunk.value.slice()); prefixBytes += chunk.value.length
                        if (prefixBytes < 3) continue
                        const first = new Uint8Array(prefixBytes); let offset = 0
                        for (const part of prefix) { first.set(part, offset); offset += part.length }
                        if (!mp3(first)) throw new SpeechCacheError("AUDIO_INVALID", "The speech provider returned invalid MP3 audio", 502)
                        job.chunks.push(first); job.ready.resolve()
                    } else job.chunks.push(chunk.value.slice())
                    notify(job)
                }
                if (job.bytes === 0 || !job.chunks.length) throw new SpeechCacheError("AUDIO_INVALID", "The speech provider returned empty audio", 502)
                await save(job)
                job.finished = true; job.done.resolve(); notify(job)
            } catch (error) {
                job.error = error; job.finished = true; job.ready.reject(error); job.done.reject(error); notify(job)
                await reader?.cancel().catch(() => {})
            } finally {
                job.abort.signal.removeEventListener("abort", cancel)
                reader?.releaseLock()
                if (pending.get(key) === job) pending.delete(key)
            }
        })()
        return job
    }
    const acquire = (request: SpeechRequest, key: string) => {
        if (closed) throw new SpeechCacheError("AUDIO_CLOSED", "Speech cache is stopping", 503)
        const existing = pending.get(key)
        const job = existing && !existing.abort.signal.aborted ? existing : begin(request, key)
        job.users++
        let released = false
        return { job, shared: !!existing, release() {
            if (released) return
            released = true; job.users--
            if (job.users === 0 && !job.finished) { job.abort.abort(); notify(job) }
        } }
    }
    const check = async (request: SpeechResponseOptions) => {
        if (request.signal?.aborted) throw abortError()
        if (request.isCurrent && !await request.isCurrent()) throw new SpeechCacheError("STALE", "Speech was interrupted", 410)
        if (request.signal?.aborted) throw abortError()
    }
    const headers = (source: string, bytes?: number): Record<string, string> => ({ "content-type": "audio/mpeg", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-apprentice-audio-source": source, ...(bytes === undefined ? {} : { "content-length": String(bytes) }) })
    return {
        async respond(request: SpeechRequest, responseOptions: SpeechResponseOptions = {}): Promise<Response> {
            await check(responseOptions)
            if (closed) throw new SpeechCacheError("AUDIO_CLOSED", "Speech cache is stopping", 503)
            const key = speechCacheKey(request)
            const cached = await readCached(key)
            await check(responseOptions)
            if (cached) return new Response(cached, { headers: headers("disk-cache", cached.length) })
            const lease = acquire(request, key)
            let cursor = 0
            let released = false
            const release = () => { if (released) return; released = true; responseOptions.signal?.removeEventListener("abort", release); lease.release() }
            responseOptions.signal?.addEventListener("abort", release, { once: true })
            try { await untilAborted(lease.job.ready.promise, responseOptions.signal); await check(responseOptions) }
            catch (error) { release(); throw error }
            const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        for (;;) {
                            await check(responseOptions)
                            if (lease.job.error) throw lease.job.error
                            const chunk = lease.job.chunks[cursor]
                            if (chunk) { cursor++; controller.enqueue(chunk.slice()); return }
                            if (lease.job.finished) { controller.close(); release(); return }
                            await untilAborted(new Promise<void>(resolve => lease.job.changed.add(resolve)), responseOptions.signal)
                        }
                    } catch (error) { controller.error(error); release() }
                },
                cancel() { release() },
            }, { highWaterMark: 0 })
            return new Response(stream, { headers: headers(lease.shared ? "shared-generation" : "generated") })
        },
        async prewarm(request: SpeechRequest, warmOptions: { signal?: AbortSignal } = {}): Promise<void> {
            if (warmOptions.signal?.aborted) throw abortError()
            const key = speechCacheKey(request)
            if (await readCached(key)) return
            if (warmOptions.signal?.aborted) throw abortError()
            const lease = acquire(request, key)
            try { await untilAborted(lease.job.done.promise, warmOptions.signal) }
            finally { lease.release() }
        },
        async stats() { await initialized; return { files: files.size, bytes: diskBytes, pending: pending.size } },
        async close() { closed = true; for (const job of pending.values()) job.abort.abort(); await Promise.allSettled([...pending.values()].map(job => job.done.promise)); await diskQueue },
    }
}
export type SpeechCache = ReturnType<typeof createSpeechCache>
