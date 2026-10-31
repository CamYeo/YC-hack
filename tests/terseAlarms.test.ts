import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startLocalActors } from "../actor/node_modules/terse-sdk/dist/dev.js"
import { createTerseRoomStore } from "../server/terse/terseRoomStore"
import type { PublicRoomState, RoomConfig } from "../actor/src/roomTypes"

const integration = process.env.RUN_TERSE_INTEGRATION === "1" ? test : test.skip
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
async function until<T>(read: () => T | undefined | null | false, timeoutMs = 5_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const result = read()
        if (result !== null && result !== undefined && result !== false) return result
        await Bun.sleep(20)
    }
    throw new Error("Terse alarm verification timed out")
}

integration("installed Terse dev runtime fires alarms and pushes state without polling", async () => {
    const project = await mkdtemp(join(tmpdir(), "apprentice-alarm-probe-"))
    let runtime: Awaited<ReturnType<typeof startLocalActors>> | null = null
    let socket: WebSocket | null = null
    try {
        await mkdir(join(project, "src"))
        await symlink(resolve(import.meta.dir, "../actor/node_modules"), join(project, "node_modules"), "dir")
        await writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "terse-sdk": "0.14.9" } }))
        await writeFile(join(project, "src/actor.ts"), `
import { Actor, Emittable, Persisted } from "terse-sdk/actor"
export class AlarmProbe extends Actor<null, null, { type: "alarm"; count: number; at: number }> {
    @Persisted @Emittable count = 0
    @Persisted private firedAt: number | null = null
    async schedule(at: number): Promise<void> { this.alarm.set(at) }
    async snapshot(): Promise<{ count: number; firedAt: number | null; alarmAt: number | null }> {
        return { count: this.count, firedAt: this.firedAt, alarmAt: this.alarm.get() }
    }
    async onAlarm(): Promise<void> {
        await this.db.transaction(async () => { this.count++; this.firedAt = Date.now() })
        this.broadcast({ type: "alarm", count: this.count, at: Date.now() })
    }
}
`)
        const options = { project, entrypoint: "src/actor.ts", projectId: "alarm-probe", dataDir: join(project, "data"), port: 0, quiet: true }
        runtime = await startLocalActors(options)
        const endpoint = () => {
            if (!runtime) throw new Error("Probe runtime is stopped")
            return `${runtime.connection.controlPlaneUrl}/v1/projects/alarm-probe/actors/AlarmProbe`
        }
        async function invoke(id: string, method: string, args: unknown[] = []): Promise<Record<string, unknown>> {
            const response = await fetch(`${endpoint()}/${id}/invoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: crypto.randomUUID(), method, args }), signal: AbortSignal.timeout(10_000) })
            const body: unknown = await response.json()
            if (!response.ok || !record(body) || !record(body.outcome) || body.outcome.type !== "completed") throw new Error("Probe invocation failed")
            return record(body.outcome.result) ? body.outcome.result : {}
        }
        const grantResponse = await fetch(`${endpoint()}/connected/find-websocket`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: null }), signal: AbortSignal.timeout(10_000) })
        const grant: unknown = await grantResponse.json()
        if (!grantResponse.ok || !record(grant) || typeof grant.websocketUrl !== "string") throw new Error("Probe socket grant failed")
        const messages: Record<string, unknown>[] = []
        socket = new WebSocket(grant.websocketUrl)
        socket.addEventListener("message", event => { const data: unknown = JSON.parse(String(event.data)); if (record(data)) messages.push(data) })
        await until(() => socket?.readyState === WebSocket.OPEN)
        await invoke("connected", "schedule", [Date.now() + 250])
        const pushed = await until(() => messages.find(message => message.type === "alarm"))
        expect(pushed.count).toBe(1)
        expect(typeof pushed.at).toBe("number")
        const first = await invoke("connected", "snapshot")
        expect(first.count).toBe(1)
        expect(first.alarmAt).toBeNull()
        expect(messages.some(message => message.type === "state" || message.type === "state_update")).toBe(true)
        socket.close(); socket = null
    } finally {
        socket?.close()
        if (runtime) await runtime.stop()
        await rm(project, { recursive: true, force: true })
    }
}, 90_000)

integration("SeminarActor expires renewed speech through push, then safely restores interrupted state after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "apprentice-alarm-room-"))
    let runtime: Awaited<ReturnType<typeof startLocalActors>> | null = null
    let unsubscribe: (() => void) | null = null
    const config: RoomConfig = { topicId: "swe-retries", topicTitle: "Retries", category: "software-engineering", format: "socratic", theme: "classroom", difficulty: "intermediate", participation: "participate", openingQuestion: "Should we retry?", customQuestion: null, reading: null, sessionMinutes: 15, maxAiTurns: 40, maxGenerationCalls: 120, aiTurnsBeforeInvite: 2, relayChannel: "sem-alarm-test" }
    try {
        const options = { project: resolve(import.meta.dir, "../actor"), entrypoint: "src/actor.ts", projectId: "local", dataDir, port: 0, quiet: true }
        runtime = await startLocalActors(options)
        const controlPlaneUrl = runtime.connection.controlPlaneUrl
        const store = createTerseRoomStore({ actorUrl: `${controlPlaneUrl}/v1/projects/local/actors` })
        if (!store.subscribe) throw new Error("Terse public subscription is missing")
        const snapshots: PublicRoomState[] = []
        const watchErrors: Error[] = []
        const roomId = "alarm-room"
        await store.startSession(roomId, { roomId, sessionId: "alarm-session", config })
        unsubscribe = await store.subscribe(roomId, state => snapshots.push(state), error => watchErrors.push(error))
        await until(() => snapshots.find(state => state.config !== null))
        const first = await store.getSnapshot(roomId)
        await store.submitProposal(roomId, { proposalId: "p1", eventId: "proposal-event", sessionId: first.sessionId, speakerId: "maya", basedOnRoomVersion: first.version, generationEpoch: first.generationEpoch, replyToContributionId: null, addressedTo: "theo", action: "contribute", text: "The first sentence was heard. The second sentence was not.", sourceIds: [], evidenceRequest: null, boardUpdate: null, relayMessageId: "test-relay", reasoning: "fixture" })
        const grant = await store.claimFloor(roomId, { proposalId: "p1", utteranceId: "u1", segments: ["The first sentence was heard.", "The second sentence was not."], leaseMs: 5_000 })
        if (!grant.ok) throw new Error("Floor was not granted")
        await Bun.sleep(2_500)
        await store.markSegmentHeard(roomId, { utteranceId: "u1", segmentIndex: 0, leaseMs: 5_000 })
        await until(() => snapshots.find(state => state.contributions[0]?.segmentsHeard === 1))
        await Bun.sleep(Math.max(0, grant.lease.expiresAt + 150 - Date.now()))
        expect(snapshots.at(-1)?.phase).toBe("discussion")
        // No snapshot polling here: the native actor alarm must produce the pushed pause.
        const expired = await until(() => snapshots.find(state => state.pauseReason === "speaker-timeout"), 5_000)
        expect(expired.phase).toBe("paused")
        expect(expired.floor).toBeNull()
        expect(expired.generationEpoch).toBeGreaterThan(grant.lease.generationEpoch)
        expect(expired.contributions[0]?.heardText).toBe("The first sentence was heard.")
        expect(expired.trace.some(entry => entry.kind === "alarm.fired")).toBe(true)
        expect("processedEventKeys" in expired || "pendingOutbound" in expired).toBe(false)
        expect(await store.markSegmentHeard(roomId, { utteranceId: "u1", segmentIndex: 1, leaseMs: 5_000 })).toEqual({ ok: false, reason: "not-speaking" })
        expect(watchErrors).toHaveLength(0)

        // Rehearse a failure during a fresh utterance; stop only this isolated test runtime.
        await store.resumeSession(roomId)
        const resumed = await store.getSnapshot(roomId)
        await store.submitProposal(roomId, { proposalId: "p2", eventId: "proposal-restart", sessionId: resumed.sessionId, speakerId: "theo", basedOnRoomVersion: resumed.version, generationEpoch: resumed.generationEpoch, replyToContributionId: "c-1", addressedTo: "maya", action: "contribute", text: "A saved prefix. An unsaid suffix.", sourceIds: [], evidenceRequest: null, boardUpdate: null, relayMessageId: "test-relay-2", reasoning: "fixture" })
        const nextGrant = await store.claimFloor(roomId, { proposalId: "p2", utteranceId: "u2", segments: ["A saved prefix.", "An unsaid suffix."], leaseMs: 120_000 })
        if (!nextGrant.ok) throw new Error("Restart floor was not granted")
        await store.markSegmentHeard(roomId, { utteranceId: "u2", segmentIndex: 0, leaseMs: 120_000 })
        await store.markEventProcessed(roomId, "theo", "saved-dedupe")
        await store.enqueueOutbound(roomId, { eventId: "pending-event", sender: "theo", target: { type: "dm", to: "bridge" }, text: "pending", envelopeJson: "{}", createdAt: Date.now(), attempts: 0 })
        await runtime.stop(); runtime = null
        runtime = await startLocalActors({ ...options, port: Number(new URL(controlPlaneUrl).port) })
        const recovered = await store.recoverAfterRestart(roomId)
        const restored = await until(() => snapshots.find(state => state.pauseReason === "restart" && state.generationEpoch === recovered.generationEpoch), 10_000)
        expect(restored.phase).toBe("paused")
        expect(restored.floor).toBeNull()
        expect(restored.contributions.at(-1)?.heardText).toBe("A saved prefix.")
        expect(restored.contributions.at(-1)?.status).toBe("interrupted")
        expect(await store.markEventProcessed(roomId, "theo", "saved-dedupe")).toBe(false)
        expect((await store.getSnapshot(roomId)).pendingOutbound.map(event => event.eventId)).toEqual(["pending-event"])
        expect(watchErrors.length).toBeGreaterThan(0)
    } finally {
        unsubscribe?.()
        if (runtime) await runtime.stop()
        await rm(dataDir, { recursive: true, force: true })
    }
}, 90_000)
