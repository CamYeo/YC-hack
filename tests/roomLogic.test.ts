import { describe, expect, test } from "bun:test"
import { createMemoryRoomStore } from "../server/seminar/memoryRoomStore"
import { setTheme as changeTheme } from "../actor/src/roomLogic"
import type { ProposalInput, RoomConfig, RoomState, SpeakerId } from "../actor/src/roomTypes"

export const roomConfig: RoomConfig = {
    topicId: "swe-retries", topicTitle: "Checkout retries", category: "software-engineering",
    format: "socratic", difficulty: "intermediate", participation: "participate",
    openingQuestion: "Should a timed-out payment be retried?", customQuestion: null, reading: null,
    sessionMinutes: 15, maxAiTurns: 40, maxGenerationCalls: 120, aiTurnsBeforeInvite: 2, relayChannel: "sem-test",
}
export function proposal(s: RoomState, speakerId: SpeakerId = "facilitator", id = crypto.randomUUID()): ProposalInput {
    return { proposalId: id, eventId: `event-${id}`, sessionId: s.sessionId, speakerId,
        basedOnRoomVersion: s.version, generationEpoch: s.generationEpoch, replyToContributionId: null,
        addressedTo: "group", action: "contribute", text: "The response may be lost. We should test a stable key.", sourceIds: [],
        evidenceRequest: null, boardUpdate: { kind: "claim", text: "Test a stable key", relation: null, targetCardId: null, attributeToHumanContributionId: null },
        relayMessageId: "relay-1", reasoning: "fixture" }
}
async function room() {
    let now = 100_000
    const store = createMemoryRoomStore(() => now)
    await store.startSession("room", { roomId: "room", sessionId: "session", config: roomConfig })
    return { store, advance: (ms: number) => { now += ms } }
}
async function claim(store: ReturnType<typeof createMemoryRoomStore>, p?: ProposalInput) {
    const candidate = p ?? proposal(await store.getSnapshot("room"))
    expect((await store.submitProposal("room", candidate)).ok).toBe(true)
    const result = await store.claimFloor("room", { proposalId: candidate.proposalId, utteranceId: `u-${candidate.proposalId}`, segments: ["The response may be lost.", "We should test a stable key."], leaseMs: 15_000 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    return result
}

describe("authoritative room transitions", () => {
    test("interrupt invalidates pending and in-flight proposals; only one floor lease", async () => {
        const { store } = await room(); const s = await store.getSnapshot("room")
        const p1 = proposal(s); const p2 = proposal(s, "maya")
        await store.submitProposal("room", p1); await store.submitProposal("room", p2)
        const first = await store.claimFloor("room", { proposalId: p1.proposalId, utteranceId: "first", segments: [p1.text], leaseMs: 15_000 })
        expect(first.ok).toBe(true)
        expect(await store.claimFloor("room", { proposalId: p2.proposalId, utteranceId: "second", segments: [p2.text], leaseMs: 15_000 })).toEqual({ ok: false, reason: "floor-busy" })
        await store.interrupt("room", "human-jump-in")
        expect(await store.submitProposal("room", proposal(s, "theo"))).toEqual({ ok: false, reason: "stale-epoch" })
        expect(await store.markSegmentHeard("room", { utteranceId: "first", segmentIndex: 0, leaseMs: 15_000 })).toEqual({ ok: false, reason: "not-speaking" })
        expect((await store.getSnapshot("room")).floor).toBeNull()
    })
    test("out-of-order acknowledgments cannot manufacture heard text; interruptions preserve only prefix", async () => {
        const { store } = await room(); const c = await claim(store)
        expect(await store.markSegmentHeard("room", { utteranceId: c.lease.utteranceId, segmentIndex: 1, leaseMs: 15_000 })).toEqual({ ok: false, reason: "out-of-order" })
        await store.markSegmentHeard("room", { utteranceId: c.lease.utteranceId, segmentIndex: 0, leaseMs: 15_000 })
        await store.markSegmentHeard("room", { utteranceId: c.lease.utteranceId, segmentIndex: 0, leaseMs: 15_000 })
        const result = await store.interrupt("room", "human-jump-in")
        expect(result.interrupted?.heardText).toBe("The response may be lost.")
        expect(result.interrupted?.segmentsHeard).toBe(1)
        expect((await store.getSnapshot("room")).board).toHaveLength(0)
    })
    test("finished signal alone never marks unacknowledged text as heard or applies its board update", async () => {
        const { store } = await room(); const c = await claim(store)
        const result = await store.finishUtterance("room", { utteranceId: c.lease.utteranceId, outcome: "completed" })
        expect(result.ok && result.contribution.status).toBe("interrupted")
        expect((await store.getSnapshot("room")).board).toHaveLength(0)
    })
    test("fully heard speech applies its board update once", async () => {
        const { store } = await room(); const c = await claim(store)
        for (let i = 0; i < 2; i++) await store.markSegmentHeard("room", { utteranceId: c.lease.utteranceId, segmentIndex: i, leaseMs: 15_000 })
        expect((await store.finishUtterance("room", { utteranceId: c.lease.utteranceId, outcome: "completed" })).ok).toBe(true)
        expect(await store.finishUtterance("room", { utteranceId: c.lease.utteranceId, outcome: "completed" })).toEqual({ ok: false, reason: "already-finished" })
        const s = await store.getSnapshot("room")
        expect(s.board).toHaveLength(1); expect(s.budget.aiTurnsUsed).toBe(1)
        expect(s.turn.hint.preferredSpeakers).toEqual(["maya"])
    })
    test("a challenge finishing after human dismissal cannot resurrect the dismissed card", async () => {
        const { store } = await room(); const first = await claim(store)
        for (let i = 0; i < 2; i++) await store.markSegmentHeard("room", { utteranceId: first.lease.utteranceId, segmentIndex: i, leaseMs: 15_000 })
        await store.finishUtterance("room", { utteranceId: first.lease.utteranceId, outcome: "completed" })
        const before = await store.getSnapshot("room"); const target = before.board[0]
        if (!target) throw new Error("Expected the first claim card")
        const p = proposal(before, "maya")
        p.boardUpdate = { kind: "claim", text: "A stable key needs server support", relation: "challenges", targetCardId: target.id, attributeToHumanContributionId: null }
        const challenge = await claim(store, p)
        await store.editBoardCard("room", { cardId: target.id, text: null, dismissed: true })
        for (let i = 0; i < 2; i++) await store.markSegmentHeard("room", { utteranceId: challenge.lease.utteranceId, segmentIndex: i, leaseMs: 15_000 })
        await store.finishUtterance("room", { utteranceId: challenge.lease.utteranceId, outcome: "completed" })
        const after = await store.getSnapshot("room")
        expect(after.board.find(card => card.id === target.id)?.status).toBe("dismissed")
        expect(after.board.find(card => card.text === "A stable key needs server support")?.relations).toEqual([])
    })
    test("human correction supersedes its old turn and marks dependent cards stale", async () => {
        const { store } = await room()
        const human = await store.appendHumanContribution("room", { eventId: "h1", text: "Use a new key.", inputMode: "text", addressedTo: "group", replyToContributionId: null, correctionOf: null })
        if (!human.ok) throw new Error(human.reason)
        await store.addHumanCard("room", { contributionId: human.contribution.id, kind: "claim", text: "Use a new key" })
        const result = await store.appendHumanContribution("room", { eventId: "h2", text: "I meant reuse the same key.", inputMode: "text", addressedTo: "maya", replyToContributionId: null, correctionOf: human.contribution.id })
        expect(result.ok).toBe(true)
        const s = await store.getSnapshot("room")
        expect(s.contributions[0]?.status).toBe("superseded"); expect(s.board[0]?.status).toBe("stale")
        expect(s.turn.hint.mode).toBe("respond-to-human"); expect(s.turn.hint.preferredSpeakers).toEqual(["maya"])
    })
    test("deduplication and durable outbox do not bump conversation version", async () => {
        const { store } = await room(); const version = (await store.getSnapshot("room")).version
        expect(await store.markEventProcessed("room", "theo", "event-1")).toBe(true)
        expect(await store.markEventProcessed("room", "theo", "event-1")).toBe(false)
        const event = { eventId: "out-1", sender: "theo", target: { type: "dm" as const, to: "bridge" }, text: "proposal", envelopeJson: "{}", createdAt: 100_000, attempts: 0 }
        await store.enqueueOutbound("room", event); await store.enqueueOutbound("room", event)
        expect((await store.getSnapshot("room")).pendingOutbound).toHaveLength(1)
        await store.markOutboundSent("room", "out-1"); await store.enqueueOutbound("room", event)
        const s = await store.getSnapshot("room"); expect(s.pendingOutbound).toHaveLength(0); expect(s.version).toBe(version)
    })
    test("failed evidence stays unresolved and duplicate result has no second effect", async () => {
        const { store } = await room()
        await store.recordEvidenceRequest("room", { requestId: "e1", requestedBy: "theo", toolId: "sim", caseId: "stable", question: "What happens?", requestRelayMessageId: null })
        const result = { requestId: "e1", status: "failed" as const, result: null, error: "No tool", resultRelayMessageId: "relay-e1" }
        expect((await store.recordEvidenceResult("room", result)).ok).toBe(true)
        expect(await store.recordEvidenceResult("room", result)).toEqual({ ok: false, reason: "duplicate" })
        const s = await store.getSnapshot("room"); expect(s.board).toHaveLength(0); expect(s.evidence[0]?.status).toBe("failed")
    })
    test("expired lease cannot accept audio acknowledgments; restart pauses without replay", async () => {
        const { store, advance } = await room(); const c = await claim(store)
        advance(16_000)
        expect(await store.markSegmentHeard("room", { utteranceId: c.lease.utteranceId, segmentIndex: 0, leaseMs: 15_000 })).toEqual({ ok: false, reason: "not-speaking" })
        const result = await store.recoverAfterRestart("room")
        expect(result.recovered).toBe(true); expect(result.phase).toBe("paused")
        expect(result.interrupted?.heardText).toBe("")
        expect((await store.resumeSession("room")).ok).toBe(true)
    })
    test("theme changes revoke active work, preserve the heard prefix, and reject old acknowledgements", async () => {
        const { store } = await room(); const first = await claim(store)
        await store.markSegmentHeard("room", { utteranceId: first.lease.utteranceId, segmentIndex: 0, leaseMs: 15_000 })
        const before = await store.getSnapshot("room")
        const result = await store.setTheme("room", "halloween")
        const after = await store.getSnapshot("room")
        expect(result.interrupted?.heardText).toBe("The response may be lost.")
        expect(after.config?.theme).toBe("halloween")
        expect(after.phase).toBe("discussion")
        expect(after.turn.awaitingHuman).toBe(before.turn.awaitingHuman)
        expect(after.generationEpoch).toBe(before.generationEpoch + 1)
        expect(after.version).toBe(before.version + 1)
        expect(after.floor).toBeNull()
        expect(after.pendingProposals).toEqual([])
        expect(after.board).toEqual([])
        expect(await store.markSegmentHeard("room", { utteranceId: first.lease.utteranceId, segmentIndex: 1, leaseMs: 15_000 })).toEqual({ ok: false, reason: "not-speaking" })
        expect(await store.submitProposal("room", proposal(before, "theo"))).toEqual({ ok: false, reason: "stale-epoch" })
        expect(await store.setTheme("room", "halloween")).toEqual({ generationEpoch: after.generationEpoch, version: after.version, interrupted: null })
    })
    test("theme updates preserve a human-owned floor and old rooms default to classroom", async () => {
        const { store } = await room()
        const initial = await store.getSnapshot("room")
        expect(initial.config?.theme).toBe("classroom")
        if (initial.config) delete initial.config.theme
        expect(changeTheme(initial, "classroom").state).toBe(initial)
        await store.interrupt("room", "human-jump-in")
        await store.setTheme("room", "halloween")
        const after = await store.getSnapshot("room")
        expect(after.turn.awaitingHuman).toBe(true)
        expect(after.turn.hint.mode).toBe("await-human")
        expect(after.floor).toBeNull()
    })
    test("changing a paused or ended room's theme never resumes or advances its epoch", async () => {
        const { store, advance } = await room()
        await store.pauseSession("room", "user-paused")
        const paused = await store.getSnapshot("room")
        advance(5_000)
        await store.setTheme("room", "halloween")
        let after = await store.getSnapshot("room")
        expect(after.phase).toBe("paused")
        expect(after.pauseReason).toBe("user-paused")
        expect(after.generationEpoch).toBe(paused.generationEpoch)
        advance(5_000)
        await store.resumeSession("room")
        after = await store.getSnapshot("room")
        expect(after.budget.endsAt).toBe(paused.budget.endsAt + 10_000)
        await store.beginReflection("room", "user-ended")
        const reflecting = await store.getSnapshot("room")
        await store.setTheme("room", "classroom")
        after = await store.getSnapshot("room")
        expect(after.phase).toBe("reflection")
        expect(after.generationEpoch).toBe(reflecting.generationEpoch)
        await store.setReflection("room", { initialPosition: null, challenge: null, revisedPosition: null, usefulQuestion: null, revisedAssumption: null, unresolved: null, nextQuestion: "What would you test next?", contributionImpact: null, generatedBy: "fixture", createdAt: 110_000 })
        const ended = await store.getSnapshot("room")
        await store.setTheme("room", "halloween")
        after = await store.getSnapshot("room")
        expect(after.phase).toBe("ended")
        expect(after.generationEpoch).toBe(ended.generationEpoch)
        expect(after.reflection).toEqual(ended.reflection)
        expect(after.floor).toBeNull()
    })
    test("snapshots cannot mutate the store and public snapshots exclude delivery bookkeeping", async () => {
        const { store } = await room(); const first = await store.getSnapshot("room")
        first.phase = "ended"
        expect((await store.getSnapshot("room")).phase).toBe("discussion")
        const snapshot = await store.startSession("room", { roomId: "room", sessionId: "session", config: roomConfig })
        expect("processedEventKeys" in snapshot).toBe(false); expect("pendingOutbound" in snapshot).toBe(false)
    })
})
