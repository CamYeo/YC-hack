import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startLocalActors } from "../actor/node_modules/terse-sdk/dist/dev.js"
import { createTerseRoomStore } from "../server/terse/terseRoomStore"
import type { RoomConfig } from "../actor/src/roomTypes"

const integration = process.env.RUN_TERSE_INTEGRATION === "1" ? test : test.skip
integration("real Terse preserves state and heard prefix across runtime restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "apprentice-terse-restart-"))
    const options = { project: resolve(import.meta.dir, "../actor"), entrypoint: "src/actor.ts", projectId: "local", port: 0, dataDir, quiet: true }
    const config: RoomConfig = { topicId: "swe-retries", topicTitle: "Retries", category: "software-engineering", format: "socratic", difficulty: "intermediate", participation: "participate", openingQuestion: "Should we retry?", customQuestion: null, reading: null, sessionMinutes: 15, maxAiTurns: 40, maxGenerationCalls: 120, aiTurnsBeforeInvite: 2, relayChannel: "sem-restart" }
    let runtime: Awaited<ReturnType<typeof startLocalActors>> | null = null
    try {
        runtime = await startLocalActors(options)
        const controlPlaneUrl = runtime.connection.controlPlaneUrl
        const store = createTerseRoomStore({ actorUrl: `${controlPlaneUrl}/v1/projects/local/actors` })
        await store.startSession("restart-test", { roomId: "restart-test", sessionId: "restart-session", config })
        await store.setTheme("restart-test", "halloween")
        const before = await store.getSnapshot("restart-test")
        await store.submitProposal("restart-test", { proposalId: "p1", eventId: "pe1", sessionId: before.sessionId, speakerId: "maya", basedOnRoomVersion: before.version, generationEpoch: before.generationEpoch, replyToContributionId: null, addressedTo: "theo", action: "contribute", text: "First sentence. Second sentence.", sourceIds: [], evidenceRequest: null, boardUpdate: null, relayMessageId: "r1", reasoning: "fixture" })
        const grant = await store.claimFloor("restart-test", { proposalId: "p1", utteranceId: "u1", segments: ["First sentence.", "Second sentence."], leaseMs: 120_000 })
        expect(grant.ok).toBe(true)
        await store.markSegmentHeard("restart-test", { utteranceId: "u1", segmentIndex: 0, leaseMs: 120_000 })
        await store.markEventProcessed("restart-test", "theo", "dedupe-1")
        await runtime.stop(); runtime = null
        runtime = await startLocalActors({ ...options, port: Number(new URL(controlPlaneUrl).port) })
        const recovered = await store.recoverAfterRestart("restart-test")
        expect(recovered.phase).toBe("paused")
        expect(recovered.interrupted?.heardText).toBe("First sentence.")
        expect(recovered.generationEpoch).toBeGreaterThan(before.generationEpoch)
        expect(await store.markEventProcessed("restart-test", "theo", "dedupe-1")).toBe(false)
        const persisted = await store.getSnapshot("restart-test")
        expect(persisted.floor).toBeNull(); expect(persisted.sessionId).toBe("restart-session")
        expect(persisted.config?.theme).toBe("halloween")
    } finally {
        if (runtime) await runtime.stop()
        await rm(dataDir, { recursive: true, force: true })
    }
}, 180_000)
