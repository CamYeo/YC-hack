/** Bounded real-audio transport rehearsal. Logical playback acknowledgements, never an audition. */
import { speakerNames } from "../shared/contracts"
import type { ClientMessage, CreateRoomResponse, ProviderStatus, ServerMessage } from "../shared/contracts"
import type { PublicRoomState } from "../actor/src/roomTypes"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { z } from "zod"

type Speech = Extract<ServerMessage, { type: "speak" }>
interface Room {
    socket: WebSocket
    state: PublicRoomState | null
    speeches: Speech[]
    failure: string | null
    closing: boolean
    startedAt: number
    previousCompletionAt: number | null
    label: string
}
class RehearsalFailure extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new RehearsalFailure(message) }
const args = process.argv.slice(2)
const cachedOnly = args.includes("--cached-only")
const baselineIndex = args.indexOf("--baseline")
const baselinePath = resolve(baselineIndex >= 0 ? args[baselineIndex + 1] ?? "" : ".local/voice-demo-baseline.json")
const supported = args.every((arg, index) => arg === "--cached-only" || arg === "--baseline" || (index > 0 && args[index - 1] === "--baseline" && !arg.startsWith("--")))
if (args.includes("--help") || !supported || (baselineIndex >= 0 && !args[baselineIndex + 1])) {
    process.stdout.write("Usage: bun --no-env-file scripts/rehearseVoiceDemo.ts [--cached-only] [--baseline FILE]\nDefault: three AI turns in each of two new rooms; saves .local/voice-demo-baseline.json.\n--cached-only: one new room, three cached intros checked against that saved baseline.\nChecks exact text, per-speaker cache-hit traces, current-room reply links, disk-cache audio and handoffs below two seconds.\nMaximum 150 seconds. Logical playback acknowledgements only; no audition or human-audio replay.\n")
    process.exit(args.includes("--help") ? 0 : 2)
}
const baselineSchema = z.object({ version: z.literal(1), topicId: z.literal("swe-retries"), theme: z.literal("halloween"), difficulty: z.literal("intermediate"), participation: z.literal("participate"), turns: z.array(z.object({ speakerId: z.enum(["facilitator", "maya", "theo"]), text: z.string().min(1) })).length(3) })
type Baseline = z.infer<typeof baselineSchema>
const origin = "http://127.0.0.1:3001"
const began = Date.now(), deadline = began + 146_000
const requestAbort = new AbortController()
const rooms: Room[] = []
const report = (value: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(value)}\n`)
let cancelled = false
const cancel = () => { cancelled = true; requestAbort.abort() }
const send = (room: Room, message: ClientMessage) => { check(room.socket.readyState === WebSocket.OPEN, "Room socket unavailable"); room.socket.send(JSON.stringify(message)) }
const hardLimit = setTimeout(() => {
    requestAbort.abort()
    for (const room of rooms) { room.closing = true; if (room.socket.readyState === WebSocket.OPEN) { room.socket.send(JSON.stringify({ type: "session.pause" } satisfies ClientMessage)); room.socket.close() } }
    process.stderr.write("Voice rehearsal failed: 150-second limit reached; own room connections closed to pause them.\n")
    process.exit(1)
}, 150_000)
process.on("SIGINT", cancel); process.on("SIGTERM", cancel)
async function waitFor<T>(room: Room | null, read: () => T | undefined | null | false, label: string): Promise<T> {
    while (Date.now() < deadline) {
        check(!cancelled, "Cancelled")
        check(!room?.failure, room?.failure ?? "Room error")
        const value = read(); if (value !== undefined && value !== null && value !== false) return value
        await Bun.sleep(15)
    }
    throw new RehearsalFailure(`Timed out waiting for ${label}`)
}
function requireLive(status: ProviderStatus) {
    check(status.reasoning.mode === "live" && /OpenAI/i.test(status.reasoning.label), "OpenAI must be live")
    check(status.voice.mode === "live" && /ElevenLabs/i.test(status.voice.label), "ElevenLabs must be live")
    check(status.relay.mode === "live" && status.relay.deliveryMode !== "memory", "Relay must use the hosted transport")
    check(status.terse.mode === "live", "Terse must be live")
}
async function createRoom(label: string): Promise<Room> {
    const startedAt = Date.now()
    const response = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: "swe-retries", category: "software-engineering", format: "socratic", difficulty: "intermediate", participation: "participate", theme: "halloween", customQuestion: null, reading: null }), signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(25_000)]) })
    check(response.status === 201, "Could not create an isolated rehearsal room")
    const created = await response.json() as CreateRoomResponse
    check(typeof created.roomId === "string" && typeof created.roomToken === "string", "Invalid room creation response")
    // Room tokens and URLs are never printed or written to a report.
    const url = new URL("/ws", origin); url.protocol = "ws:"
    url.searchParams.set("roomId", created.roomId); url.searchParams.set("roomToken", created.roomToken)
    const socket = new WebSocket(url)
    const room: Room = { socket, state: null, speeches: [], failure: null, closing: false, startedAt, previousCompletionAt: null, label }
    rooms.push(room)
    socket.addEventListener("error", () => { if (!room.closing) room.failure = "Room socket failed" })
    socket.addEventListener("close", () => { if (!room.closing) room.failure = "Room socket closed" })
    socket.addEventListener("message", event => {
        try {
            const message = JSON.parse(String(event.data)) as ServerMessage
            if (message.type === "snapshot") room.state = message.state
            else if (message.type === "speak") room.speeches.push(message)
            else if (message.type === "welcome" || message.type === "providers") requireLive(message.providers)
            else if (message.type === "notice" && message.level === "error") room.failure = "Backend reported a room error"
        } catch { room.failure = "Invalid room message or non-live provider" }
    })
    await waitFor(room, () => socket.readyState === WebSocket.OPEN, "room connection")
    send(room, { type: "hello", clientId: `voice-rehearsal-${crypto.randomUUID()}`, resume: false })
    return room
}
async function nextSpeech(room: Room): Promise<Speech> {
    const speech = await waitFor(room, () => room.speeches.find(item => room.state?.floor?.utteranceId === item.utteranceId && room.state.generationEpoch === item.generationEpoch), "approved speech")
    room.speeches.splice(room.speeches.indexOf(speech), 1)
    check(speech.voice.mode === "elevenlabs", "Speech plan is not ElevenLabs")
    return speech
}
const textCacheTrace = (room: Room, speakerId: Speech["speakerId"]) => room.state?.trace.find(item => item.channel === "system" && item.from === speakerId && (item.kind === "opening.cache-hit" || item.kind === "intro.cache-hit"))
async function requireTextCacheHit(room: Room, speakerId: Speech["speakerId"]) {
    const end = Math.min(deadline,Date.now()+2000)
    while (!textCacheTrace(room,speakerId) && Date.now()<end && !room.failure) await Bun.sleep(15)
    check(textCacheTrace(room,speakerId), `Expected prepared text for ${speakerId}; no cache-hit trace appeared, so the rehearsal is stopping`)
}
async function fetchSpeech(room: Room, speech: Speech, complete: boolean) {
    check(speech.voice.mode === "elevenlabs", "Expected ElevenLabs segment URLs")
    check(speech.voice.segmentUrls.length === speech.segments.length && speech.segments.length > 0, "Invalid speech segment plan")
    const proposal = room.state?.pendingProposals.find(item => item.proposalId === room.state?.floor?.proposalId)
    check(proposal?.reasoning === "openai" && proposal.relayMessageId, "Speech must come from an OpenAI proposal over Relay")
    const records: { segment: number; bytes: number; source: string | null; firstByteMs: number; fullMs: number }[] = []
    let firstByteAt = 0
    for (let index = 0; index < speech.segments.length; index++) {
        const segmentUrl = speech.voice.segmentUrls[index]
        check(typeof segmentUrl === "string", "Missing TTS URL")
        const url = new URL(segmentUrl, origin)
        check(url.origin === origin && url.pathname.startsWith("/api/tts/"), "Unexpected audio origin")
        const started = Date.now()
        const response = await fetch(url, { signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(30_000)]) })
        check(response.ok, `TTS request failed with HTTP ${response.status}`)
        check(/^audio\/mpeg/i.test(response.headers.get("content-type") ?? ""), "TTS response is not MP3")
        check(response.body, "TTS response body missing")
        const reader = response.body.getReader()
        let bytes = 0, firstByteMs = 0
        const prefix: number[] = []
        for (;;) {
            const item = await reader.read()
            if (item.done) break
            if (!item.value.length) continue
            if (bytes === 0) { firstByteMs = Date.now() - started; if (!firstByteAt) firstByteAt = Date.now() }
            for (const byte of item.value) { if (prefix.length === 3) break; prefix.push(byte) }
            bytes += item.value.length
            check(bytes <= 8 * 1024 * 1024, "Audio segment exceeded the bounded rehearsal limit")
        }
        check(bytes > 0 && ((prefix[0] === 0x49 && prefix[1] === 0x44 && prefix[2] === 0x33) || (prefix[0] === 0xff && ((prefix[1] ?? 0) & 0xe0) === 0xe0)), "TTS response has an invalid MP3 signature")
        records.push({ segment: index + 1, bytes, source: response.headers.get("x-apprentice-audio-source"), firstByteMs, fullMs: Date.now() - started })
        check(room.state?.floor?.utteranceId === speech.utteranceId, "Speech was revoked during its audio request")
        // Explicitly protocol-only: downloaded bytes are not evidence of human listening.
        send(room, { type: "playback.segment", utteranceId: speech.utteranceId, segmentIndex: index, event: "started" })
        send(room, { type: "playback.segment", utteranceId: speech.utteranceId, segmentIndex: index, event: "ended" })
        await waitFor(room, () => room.state?.contributions.find(item => item.id === speech.contributionId && item.segmentsHeard === index + 1), "logical segment acknowledgement")
    }
    const text = speech.segments.join(" ")
    const contribution = room.state?.contributions.find(item => item.id === speech.contributionId)
    check(contribution, "Approved contribution missing from current room")
    const firstAudioWaitMs = firstByteAt - (room.previousCompletionAt ?? room.startedAt)
    report({ room: room.label, speaker: speakerNames("halloween")[speech.speakerId], text, textCacheHit: !!textCacheTrace(room,speech.speakerId), contributionId: contribution.id, replyToContributionId: contribution.replyToContributionId, timings: { boundary: room.previousCompletionAt ? "previous logical completion → first audio byte" : "room creation → first audio byte", firstAudioWaitMs }, segments: records, playback: "downloaded and logically acknowledged; not auditioned" })
    if (complete) {
        room.previousCompletionAt = Date.now()
        send(room, { type: "playback.finished", utteranceId: speech.utteranceId, outcome: "completed", error: null })
        await waitFor(room, () => room.state?.contributions.find(item => item.id === speech.contributionId && item.status === "heard" && item.relayMessageId), "completed contribution through Relay")
    }
    return { speakerId: speech.speakerId, text, records, contributionId: contribution.id, replyToContributionId: contribution.replyToContributionId, firstAudioWaitMs }
}
async function pause(room: Room) {
    if (room.socket.readyState === WebSocket.OPEN) {
        send(room, { type: "session.pause" })
        const end = Math.min(began + 149_000, Date.now() + 2000)
        while (Date.now() < end && room.state?.phase === "discussion") await Bun.sleep(15)
    }
    room.closing = true; room.socket.close(1000, "Voice rehearsal complete")
}
try {
    report({ rehearsal: "Real ElevenLabs audio transport; logical playback acknowledgements only, no audition", budget: cachedOnly ? "One room with three previously prepared intro turns; maximum 150 seconds" : "Three initial AI turns in each of two new rooms; maximum 150 seconds" })
    let baseline: Baseline | null = cachedOnly ? baselineSchema.parse(JSON.parse(await readFile(baselinePath,"utf8"))) : null
    if (baseline) check(new Set(baseline.turns.map(turn => turn.speakerId)).size === 3 && baseline.turns[0]?.speakerId === "facilitator", "Baseline must contain all three introductory speakers")
    const statusResponse = await fetch(`${origin}/api/status`, { signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(10_000)]) })
    check(statusResponse.ok, "Backend status unavailable")
    const status = await statusResponse.json() as ProviderStatus; requireLive(status)
    if(cachedOnly)check(/opening exchange cache enabled/i.test(status.reasoning.label),"Cached-only mode requires the prepared opening exchange to be enabled")
    report({ providers: { reasoning: status.reasoning.label, voice: status.voice.label, relayDelivery: status.relay.deliveryMode } })
    if (!baseline) {
        const first = await createRoom("warm-rehearsal")
        const turns = []
        for (let turn = 0; turn < 3; turn++) turns.push(await fetchSpeech(first, await nextSpeech(first), turn < 2))
        check(new Set(turns.map(turn => turn.speakerId)).size === 3, "First three turns did not include all three speakers")
        await pause(first)
        baseline = baselineSchema.parse({ version: 1, topicId: "swe-retries", theme: "halloween", difficulty: "intermediate", participation: "participate", turns: turns.map(({ speakerId,text }) => ({ speakerId,text })) })
        await mkdir(dirname(baselinePath),{recursive:true,mode:0o700})
        const temporary = `${baselinePath}.${crypto.randomUUID()}.tmp`
        await writeFile(temporary,JSON.stringify(baseline,null,2)+"\n",{mode:0o600}); await rename(temporary,baselinePath)
        report({baselineSaved:baselinePath})
        check(Date.now() < deadline - 35_000, "Insufficient remaining budget for matching-room proof")
    }
    const second = await createRoom("matching-intro")
    const repeated = []
    for (let turn = 0; turn < 3; turn++) {
        const speech = await nextSpeech(second)
        await requireTextCacheHit(second,speech.speakerId)
        check(speech.speakerId === baseline.turns[turn]?.speakerId && speech.segments.join(" ") === baseline.turns[turn]?.text, `Matching turn ${turn + 1} differed from the saved baseline`)
        const replay = await fetchSpeech(second, speech, turn < 2)
        repeated.push(replay)
        check(replay.records.every(segment => segment.source === "disk-cache"), `Matching turn ${turn + 1} did not reuse all audio from disk`)
        if (turn > 0) {
            const expectedParent = repeated.slice(0,-1).find(previous => previous.contributionId === replay.replyToContributionId)
            check(expectedParent, "Cached peer reply does not reference an earlier contribution in its current room")
            // IDs such as c-1 are intentionally scoped to a room, so equality with another room's
            // IDs proves nothing. Resolve the parent in this actual snapshot and verify its text.
            const currentParent = second.state?.contributions.find(item => item.id === replay.replyToContributionId)
            check(currentParent?.status === "heard" && currentParent.heardText === expectedParent.text, "Cached peer reply does not resolve to the actual heard parent in its current room")
        }
    }
    await pause(second)
    const handoffs = repeated.slice(1).map(turn => ({ speaker: speakerNames("halloween")[turn.speakerId], waitMs: turn.firstAudioWaitMs }))
    report({ cacheProof: "All three texts match; per-speaker cache-hit traces present; every audio segment disk-cache; peer links rebased to the current room", cachedHandoffs: handoffs, targetMs: 2000 })
    check(handoffs.every(handoff => handoff.waitMs < 2000), "A cached introduction handoff exceeded the two-second target")
    report({ result: "PASS", elapsedMs: Date.now() - began })
} catch (error) {
    process.stderr.write(`Voice rehearsal failed: ${error instanceof RehearsalFailure ? error.message : cancelled ? "Cancelled" : "Request or protocol failure"}.\n`)
    process.exitCode = 1
} finally {
    for (const room of rooms) { try { await pause(room) } catch { room.closing = true; room.socket.close() } }
    requestAbort.abort(); clearTimeout(hardLimit)
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel)
}
