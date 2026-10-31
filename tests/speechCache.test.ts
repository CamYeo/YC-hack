import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSpeechCache, speechCacheKey, type SpeechRequest } from "../server/speech/cache"

const request: SpeechRequest = { voiceId: "fixture-voice", modelId: "fixture-model", outputFormat: "mp3_44100_128", voiceSettings: { speed: 1, stability: .5 }, text: "Could the payment have succeeded?" }
const audio = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5])
const temporary = () => mkdtempSync(join(tmpdir(), "apprentice-speech-cache-"))
const until = async (check: () => boolean) => { const end = Date.now() + 1000; while (!check()) { if (Date.now() > end) throw new Error("Audio fixture timed out"); await Bun.sleep(2) } }
function controlled() {
    let source!: ReadableStreamDefaultController<Uint8Array>
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller }, cancel() { cancelled = true } })
    return { source, response: new Response(body, { headers: { "content-type": "audio/mpeg" } }), cancelled: () => cancelled }
}

describe("persistent speech cache", () => {
    test("key includes exact voice, model, format, settings and text, with stable object ordering", () => {
        const base = speechCacheKey(request)
        expect(speechCacheKey({ ...request, voiceSettings: { stability: .5, speed: 1 } })).toBe(base)
        for (const change of [{ voiceId: "another" }, { modelId: "another" }, { outputFormat: "another" }, { text: "Another question?" }, { voiceSettings: { speed: 1.1, stability: .5 } }]) expect(speechCacheKey({ ...request, ...change })).not.toBe(base)
    })
    test("streams first bytes before synthesis completes, then reuses complete audio after restart", async () => {
        const directory = temporary(); const source = controlled(); let generated = 0
        const cache = createSpeechCache({ directory, generate: async () => { generated++; return source.response } })
        let restarted: ReturnType<typeof createSpeechCache> | null = null
        try {
            const promised = cache.respond(request)
            await until(() => generated === 1); source.source.enqueue(audio.slice(0, 4))
            const response = await promised
            expect(response.headers.get("x-apprentice-audio-source")).toBe("generated")
            const reader = response.body!.getReader()
            expect((await reader.read()).value).toEqual(audio.slice(0, 4))
            expect((await cache.stats()).files).toBe(0)
            source.source.enqueue(audio.slice(4)); source.source.close()
            expect((await reader.read()).value).toEqual(audio.slice(4)); expect((await reader.read()).done).toBe(true)
            await cache.close()
            expect(statSync(join(directory, `${speechCacheKey(request)}.mp3`)).mode & 0o777).toBe(0o600)
            restarted = createSpeechCache({ directory, generate: async () => { throw new Error("Cached audio must not synthesize again") } })
            const reused = await restarted.respond(request)
            expect(reused.headers.get("x-apprentice-audio-source")).toBe("disk-cache")
            expect(new Uint8Array(await reused.arrayBuffer())).toEqual(audio)
            expect(generated).toBe(1)
        } finally { await cache.close(); await restarted?.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("concurrent rooms share generation; one cancelled request cannot abort the other", async () => {
        const directory = temporary(); const source = controlled(); let generated = 0; let providerSignal: AbortSignal | null = null
        const cache = createSpeechCache({ directory, generate: async (_input, signal) => { generated++; providerSignal = signal; return source.response } })
        const firstAbort = new AbortController()
        try {
            const first = cache.respond(request, { signal: firstAbort.signal }); const second = cache.respond(request)
            await until(() => generated === 1); source.source.enqueue(audio.slice(0, 4))
            const [a, b] = await Promise.all([first, second])
            firstAbort.abort(); await a.body!.cancel()
            expect((providerSignal as AbortSignal | null)?.aborted).toBe(false)
            source.source.enqueue(audio.slice(4)); source.source.close()
            expect(new Uint8Array(await b.arrayBuffer())).toEqual(audio)
            expect(generated).toBe(1); expect(b.headers.get("x-apprentice-audio-source")).toBe("shared-generation")
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("a running server discovers audio prepared by a separate warmer without restart", async () => {
        const directory = temporary()
        const server = createSpeechCache({ directory, generate: async () => { throw new Error("Warm audio should already be on disk") } })
        const warmer = createSpeechCache({ directory, generate: async () => new Response(audio, { headers: { "content-type": "audio/mpeg" } }) })
        try {
            expect((await server.stats()).files).toBe(0)
            await warmer.prewarm(request)
            const response = await server.respond(request)
            expect(response.headers.get("x-apprentice-audio-source")).toBe("disk-cache")
            expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio)
        } finally { await server.close(); await warmer.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("last cancelled consumer aborts provider, never saves partial audio, and a retry generates afresh", async () => {
        const directory = temporary(); const source = controlled(); let calls = 0
        const cache = createSpeechCache({ directory, generate: async () => { calls++; return calls === 1 ? source.response : new Response(audio, { headers: { "content-type": "audio/mpeg" } }) } })
        try {
            const response = cache.respond(request); await until(() => calls === 1); source.source.enqueue(audio.slice(0, 4))
            await (await response).body!.cancel(); await until(source.cancelled)
            expect((await cache.stats()).files).toBe(0)
            const retry = await cache.respond(request); expect(new Uint8Array(await retry.arrayBuffer())).toEqual(audio)
            expect(calls).toBe(2); expect((await cache.stats()).files).toBe(1)
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("prewarming joins playback without a second request and cancellation stops unused work", async () => {
        const directory = temporary(); const source = controlled(); let calls = 0
        const cache = createSpeechCache({ directory, generate: async () => { calls++; return source.response } })
        const abort = new AbortController()
        try {
            const warm = cache.prewarm(request, { signal: abort.signal }); void warm.catch(() => {})
            await until(() => calls === 1)
            const response = cache.respond(request); source.source.enqueue(audio.slice(0, 4))
            const playing = await response; abort.abort()
            await expect(warm).rejects.toMatchObject({ name: "AbortError" })
            expect(source.cancelled()).toBe(false)
            source.source.enqueue(audio.slice(4)); source.source.close()
            expect(new Uint8Array(await playing.arrayBuffer())).toEqual(audio); expect(calls).toBe(1)
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("stale lease rejects cache hits and prevents streaming additional chunks after interruption", async () => {
        const directory = temporary(); const source = controlled(); let started = false; let current = true
        const cache = createSpeechCache({ directory, generate: async () => { started = true; return source.response } })
        try {
            const promised = cache.respond(request, { isCurrent: async () => current })
            await until(() => started); source.source.enqueue(audio.slice(0, 4))
            const reader = (await promised).body!.getReader(); await reader.read()
            current = false; source.source.enqueue(audio.slice(4))
            await expect(reader.read()).rejects.toMatchObject({ code: "STALE", status: 410 })
            await until(source.cancelled)
            expect((await cache.stats()).files).toBe(0)
            await expect(cache.respond(request, { isCurrent: async () => false })).rejects.toMatchObject({ code: "STALE" })
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("bounds persisted size and entries; evicted or corrupt audio regenerates", async () => {
        const directory = temporary(); let generated = 0
        const cache = createSpeechCache({ directory, limits: { maxFiles: 2, maxDiskBytes: 16 }, generate: async () => { generated++; return new Response(audio, { headers: { "content-type": "audio/mpeg" } }) } })
        try {
            for (const text of ["first", "second", "third"]) await cache.prewarm({ ...request, text })
            expect((await cache.stats()).files).toBe(2); expect((await cache.stats()).bytes).toBe(16)
            expect(readdirSync(directory)).not.toContain(`${speechCacheKey({ ...request, text: "first" })}.mp3`)
            const third = { ...request, text: "third" }
            writeFileSync(join(directory, `${speechCacheKey(third)}.mp3`), "not-mp3!")
            await cache.prewarm(third); expect(generated).toBe(4)
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("invalid provider audio and oversized output never become cache entries", async () => {
        const directory = temporary(); let calls = 0
        const cache = createSpeechCache({ directory, limits: { maxEntryBytes: 6 }, generate: async () => { calls++; return calls === 1 ? Response.json({ error: "not audio" }) : new Response(audio, { headers: { "content-type": "audio/mpeg" } }) } })
        try {
            await expect(cache.prewarm(request)).rejects.toMatchObject({ code: "AUDIO_INVALID" })
            await expect(cache.prewarm(request)).rejects.toMatchObject({ code: "AUDIO_LIMIT" })
            expect((await cache.stats()).files).toBe(0)
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
    test("a cached file cannot bypass a revoked lease, and concurrency limits bound new generations", async () => {
        const directory = temporary(); const source = controlled(); let calls = 0
        const cache = createSpeechCache({ directory, limits: { maxPending: 1 }, generate: async () => { calls++; return calls === 1 ? new Response(audio, { headers: { "content-type": "audio/mpeg" } }) : source.response } })
        try {
            await cache.prewarm(request)
            await expect(cache.respond(request, { isCurrent: async () => false })).rejects.toMatchObject({ code: "STALE" })
            expect(calls).toBe(1)
            const warm = cache.prewarm({ ...request, text: "Another line" }); void warm.catch(() => {})
            await until(() => calls === 2)
            await expect(cache.prewarm({ ...request, text: "Over capacity" })).rejects.toMatchObject({ code: "AUDIO_BUSY" })
            expect(calls).toBe(2)
            source.source.enqueue(audio); source.source.close(); await warm
        } finally { await cache.close(); rmSync(directory, { recursive: true, force: true }) }
    })
})
