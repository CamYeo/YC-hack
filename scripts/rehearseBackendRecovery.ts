/** Actual backend crash recovery, with real local Terse and explicitly fixture-only providers. */
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { startLocalActors } from "../actor/node_modules/terse-sdk/dist/dev.js"
import { createTerseRoomStore } from "../server/terse/terseRoomStore"
import type { ClientMessage, CreateRoomResponse, ProviderStatus, ServerMessage } from "../shared/contracts"
import type { PublicRoomState } from "../actor/src/roomTypes"

class RecoveryFailure extends Error {}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new RecoveryFailure(message) }
type Speech = Extract<ServerMessage, { type: "speak" }>
type Connection = { socket: WebSocket; state: PublicRoomState | null; providers: ProviderStatus | null; speeches: Speech[]; metrics: Extract<ServerMessage, { type: "metric" }>[] }
const root = resolve(import.meta.dir, "..")
const executable = resolve(root, "node_modules/.bin/bun")
const startedAt = Date.now()
const deadline = startedAt + 90_000
const cancel = new AbortController()
const cancelRun = () => cancel.abort()
process.on("SIGINT", cancelRun)
process.on("SIGTERM", cancelRun)
const timeout = setTimeout(cancelRun, 90_000)
const connections: Connection[] = []
let runtime: Awaited<ReturnType<typeof startLocalActors>> | null = null
let backend: ReturnType<typeof Bun.spawn> | null = null
let tempRoot: string | null = null
let stage = "initializing isolated services"
const childEnvironment: Record<string, string> = { PATH: `${dirname(executable)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: process.env.HOME ?? "", USER: process.env.USER ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8", NO_COLOR: "1" }
const report = (data: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(data)}\n`)
async function waitFor<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, maximumMs = 15_000): Promise<T> {
    const until = Math.min(deadline, Date.now() + maximumMs)
    while (Date.now() < until) {
        check(!cancel.signal.aborted, "Rehearsal cancelled or timed out")
        const value = await read()
        if (value !== undefined && value !== null && value !== false) return value
        await Bun.sleep(25)
    }
    throw new RecoveryFailure("Timed out")
}
function send(connection: Connection, message: ClientMessage) {
    check(connection.socket.readyState === WebSocket.OPEN, "Test room socket is unavailable")
    connection.socket.send(JSON.stringify(message))
}
async function connect(origin: string, room: CreateRoomResponse, resume: boolean): Promise<Connection> {
    const url = new URL("/ws", origin)
    url.protocol = "ws:"
    url.searchParams.set("roomId", room.roomId)
    url.searchParams.set("roomToken", room.roomToken)
    // The URL contains the room credential; it is never written to output.
    const connection: Connection = { socket: new WebSocket(url), state: null, providers: null, speeches: [], metrics: [] }
    connections.push(connection)
    connection.socket.addEventListener("message", event => {
        const message = JSON.parse(String(event.data)) as ServerMessage
        if (message.type === "snapshot") connection.state = message.state
        else if (message.type === "welcome" || message.type === "providers") connection.providers = message.providers
        else if (message.type === "speak") connection.speeches.push(message)
        else if (message.type === "metric") connection.metrics.push(message)
    })
    await waitFor(() => connection.socket.readyState === WebSocket.OPEN)
    send(connection, { type: "hello", clientId: `recovery-${crypto.randomUUID()}`, resume })
    await waitFor(() => connection.providers)
    return connection
}
async function stopOwnedBackend(force = false) {
    const child = backend
    if (!child) return
    backend = null
    child.kill(force ? "SIGKILL" : "SIGTERM")
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    try { await child.exited } finally { clearTimeout(killTimer) }
}

try {
    report({ rehearsal: "Backend process crash with real local Terse durability", reasoning: "fixture", relay: "in-memory fixture", voice: "logical text playback; no audio or provider requests" })
    tempRoot = await mkdtemp(join(tmpdir(), "apprentice-backend-recovery-"))
    runtime = await startLocalActors({ project: join(root, "actor"), entrypoint: "src/actor.ts", projectId: "local", port: 0, dataDir: join(tempRoot, "actor-state"), quiet: true, startupTimeoutMs: 25_000 })
    const actorUrl = `${runtime.connection.controlPlaneUrl}/v1/projects/local/actors`
    const store = createTerseRoomStore({ actorUrl })
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const port = reservation.port
    await reservation.stop(true)
    const origin = `http://127.0.0.1:${port}`
    await writeFile(join(tempRoot, ".env.hackathon.local"), `APP_MODE=fixture\nHACKATHON_SERVER_PORT=${port}\nTERSE_LOCAL_URL=${actorUrl}\n`, { mode: 0o600 })
    async function startBackend(): Promise<ProviderStatus> {
        check(tempRoot, "Temporary configuration is missing")
        backend = Bun.spawn([executable, "--no-env-file", join(root, "server/index.ts"), "--repo-root", tempRoot], { cwd: root, env: childEnvironment, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        return waitFor(async () => {
            check(backend && backend.exitCode === null, "Isolated backend exited before readiness")
            try {
                const response = await fetch(`${origin}/api/status`, { signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(500)]) })
                return response.ok ? await response.json() as ProviderStatus : null
            } catch { return null }
        }, 20_000)
    }
    const providers = await startBackend()
    check(providers.reasoning.mode === "fixture" && providers.relay.mode === "fixture" && providers.relay.deliveryMode === "memory" && providers.voice.mode === "fixture" && providers.terse.mode === "live", "Rehearsal requires fixture providers and real local Terse")
    stage = "creating the fixture seminar"
    const response = await fetch(`${origin}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: "swe-retries", category: "software-engineering", format: "socratic", difficulty: "intermediate", participation: "participate", theme: "classroom", customQuestion: null, reading: null }), signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]) })
    check(response.status === 201, "Test room creation failed")
    const room = await response.json() as CreateRoomResponse
    const firstConnection = await connect(origin, room, false)
    stage = "acknowledging only the first sentence"
    const firstSpeech = await waitFor(() => firstConnection.speeches[0])
    check(firstSpeech.segments.length >= 2, "The fixture opening must contain at least two playback segments")
    const prefix = firstSpeech.segments[0]
    check(prefix, "The opening has no first segment")
    const suffix = firstSpeech.segments.slice(1).join(" ")
    send(firstConnection, { type: "playback.segment", utteranceId: firstSpeech.utteranceId, segmentIndex: 0, event: "started" })
    send(firstConnection, { type: "playback.segment", utteranceId: firstSpeech.utteranceId, segmentIndex: 0, event: "ended" })
    await waitFor(() => firstConnection.state?.contributions.find(item => item.id === firstSpeech.contributionId && item.segmentsHeard === 1))
    const persistedBeforeCrash = await store.getSnapshot(room.roomId)
    const before = persistedBeforeCrash.contributions.find(item => item.id === firstSpeech.contributionId)
    check(before?.status === "speaking" && before.heardText === prefix && persistedBeforeCrash.floor?.utteranceId === firstSpeech.utteranceId, "The heard prefix was not persisted while the utterance was active")
    const oldEpoch = persistedBeforeCrash.generationEpoch
    report({ checkpoint: "Before crash", heardPrefix: prefix, unheardSegmentCount: firstSpeech.segments.length - 1, generationEpoch: oldEpoch, floor: "occupied" })

    stage = "killing only the owned backend process"
    await stopOwnedBackend(true)
    stage = "restarting with the same private registry"
    await startBackend()
    const recoveredConnection = await connect(origin, room, true)
    const recovered = await waitFor(() => recoveredConnection.state?.phase === "paused" && recoveredConnection.state.pauseReason === "reconnected" && recoveredConnection.state)
    const saved = recovered.contributions.find(item => item.id === firstSpeech.contributionId)
    check(recovered.floor === null && recovered.generationEpoch > oldEpoch, "Restart did not revoke the old lease and epoch")
    check(saved?.status === "interrupted" && saved.segmentsHeard === 1 && saved.heardText === prefix, "Restart changed the heard prefix")
    check(!saved.heardText.includes(suffix), "Unheard text was promoted to shared conversation")
    check(recovered.trace.some(item => item.kind === "recovery.restored"), "Backend recovery was not observed")
    check(recovered.trace.filter(item => item.kind === "contribution.heard").every(item => !item.summary.includes(suffix)), "Unheard text appeared in a published contribution")
    await Bun.sleep(250)
    check(recoveredConnection.speeches.length === 0, "Restart replayed speech before explicit resume")

    stage = "rejecting callbacks from the dead utterance"
    send(recoveredConnection, { type: "playback.segment", utteranceId: firstSpeech.utteranceId, segmentIndex: 1, event: "ended" })
    send(recoveredConnection, { type: "playback.finished", utteranceId: firstSpeech.utteranceId, outcome: "completed", error: null })
    send(recoveredConnection, { type: "metric", name: "interrupt-to-silence", ms: 1234.567 })
    await waitFor(() => recoveredConnection.metrics.find(item => item.name === "interrupt-to-silence" && item.ms === 1234.567))
    const afterStaleCallbacks = await store.getSnapshot(room.roomId)
    const afterStale = afterStaleCallbacks.contributions.find(item => item.id === firstSpeech.contributionId)
    check(afterStaleCallbacks.phase === "paused" && afterStaleCallbacks.floor === null && afterStale?.heardText === prefix && afterStale.segmentsHeard === 1 && afterStale.status === "interrupted", "A stale callback advanced the recovered room")
    report({ checkpoint: "After restart", heardPrefix: afterStale.heardText, generationEpoch: afterStaleCallbacks.generationEpoch, floor: "empty", staleCallbacks: "rejected", automaticReplay: false })

    stage = "resuming into a new turn"
    send(recoveredConnection, { type: "session.resume" })
    const nextSpeech = await waitFor(() => recoveredConnection.speeches.find(item => item.utteranceId !== firstSpeech.utteranceId && item.generationEpoch > oldEpoch), 12_000)
    check(nextSpeech.contributionId !== firstSpeech.contributionId, "Resume reused the interrupted contribution")
    const next = await waitFor(() => recoveredConnection.state?.contributions.find(item => item.id === nextSpeech.contributionId))
    check(next.replyToContributionId === firstSpeech.contributionId, "Resumed peer did not use the saved contribution as context")
    send(recoveredConnection, { type: "session.pause" })
    await waitFor(() => recoveredConnection.state?.phase === "paused" && !recoveredConnection.state.floor && recoveredConnection.state)
    report({ result: "PASS", recovery: "Actual owned backend SIGKILL and restart", durability: "Real isolated Terse", reasoningAndRelay: "Fixtures only", resume: "Fresh utterance replying to the saved prefix", elapsedMs: Date.now() - startedAt })
} catch (error) {
    process.stderr.write(`Backend recovery rehearsal failed while ${stage}: ${error instanceof RecoveryFailure ? error.message : "local request or process failure"}.\n`)
    process.exitCode = 1
} finally {
    for (const connection of connections) connection.socket.close()
    await stopOwnedBackend()
    if (runtime) await runtime.stop()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    clearTimeout(timeout)
    cancel.abort()
    process.off("SIGINT", cancelRun)
    process.off("SIGTERM", cancelRun)
}
