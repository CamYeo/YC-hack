import { expect, test } from "bun:test"
import * as logic from "../actor/src/roomLogic"
import type { RoomConfig, RoomState } from "../actor/src/roomTypes"

const config: RoomConfig = { topicId: "swe-retries", topicTitle: "Retries", category: "software-engineering", format: "socratic", theme: "classroom", difficulty: "intermediate", participation: "participate", openingQuestion: "Should we retry?", customQuestion: null, reading: null, sessionMinutes: 1, maxAiTurns: 10, maxGenerationCalls: 30, aiTurnsBeforeInvite: 2, relayChannel: "sem-expiry" }
function speaking(): RoomState {
    const started = logic.startSession(logic.emptyRoomState("expiry", 1_000), { roomId: "expiry", sessionId: "session", config }, 1_000).state
    const proposed = logic.submitProposal(started, { proposalId: "proposal", eventId: "proposal-event", sessionId: started.sessionId, speakerId: "maya", basedOnRoomVersion: started.version, generationEpoch: started.generationEpoch, replyToContributionId: null, addressedTo: "theo", action: "contribute", text: "The first charge may succeed. The next claim is unheard.", sourceIds: [], evidenceRequest: null, boardUpdate: { kind: "claim", text: "An unheard claim", relation: null, targetCardId: null, attributeToHumanContributionId: null }, relayMessageId: "relay-proposal", reasoning: "fixture" }, 1_000).state
    return logic.claimFloor(proposed, { proposalId: "proposal", utteranceId: "utterance", segments: ["The first charge may succeed.", "The next claim is unheard."], leaseMs: 5_000 }, 1_000).state
}

test("Terse alarm expiry revokes only the expired lease and conserves the heard prefix", () => {
    const heard = logic.markSegmentHeard(speaking(), { utteranceId: "utterance", segmentIndex: 0, leaseMs: 5_000 }, 2_000).state
    expect(logic.nextAlarmAt(heard)).toBe(7_000)
    const expired = logic.expireDueTimers(heard, 7_000)
    expect(expired.result?.interrupted?.heardText).toBe("The first charge may succeed.")
    expect(expired.state.phase).toBe("paused")
    expect(expired.state.pauseReason).toBe("speaker-timeout")
    expect(expired.state.generationEpoch).toBe(heard.generationEpoch + 1)
    expect(expired.state.floor).toBeNull()
    expect(expired.state.pendingProposals).toEqual([])
    expect(expired.state.board).toEqual([])
    expect(logic.nextAlarmAt(expired.state)).toBeNull()
    expect(logic.expireDueTimers(expired.state, 8_000).state).toBe(expired.state)
    expect(logic.markSegmentHeard(expired.state, { utteranceId: "utterance", segmentIndex: 1, leaseMs: 5_000 }, 8_000).result).toEqual({ ok: false, reason: "not-speaking" })
})

test("an old alarm cannot expire a lease renewed by a completed segment", () => {
    const before = speaking()
    expect(logic.nextAlarmAt(before)).toBe(6_000)
    const renewed = logic.markSegmentHeard(before, { utteranceId: "utterance", segmentIndex: 0, leaseMs: 5_000 }, 4_000).state
    expect(logic.nextAlarmAt(renewed)).toBe(9_000)
    expect(logic.expireDueTimers(renewed, 6_000).state).toBe(renewed)
    expect(logic.expireDueTimers(renewed, 9_000).state.phase).toBe("paused")
})

test("session deadline takes precedence, enters reflection, and cannot replay expired speech", () => {
    const heard = logic.markSegmentHeard(speaking(), { utteranceId: "utterance", segmentIndex: 0, leaseMs: 120_000 }, 2_000).state
    expect(logic.nextAlarmAt(heard)).toBe(61_000)
    const expired = logic.expireDueTimers(heard, 61_000)
    expect(expired.state.phase).toBe("reflection")
    expect(expired.state.pauseReason).toBe("session-timeout")
    expect(expired.result?.interrupted?.heardText).toBe("The first charge may succeed.")
    expect(expired.state.floor).toBeNull()
    expect(expired.state.board).toEqual([])
    expect(logic.nextAlarmAt(expired.state)).toBeNull()
    expect(expired.state.trace.at(-1)?.kind).toBe("alarm.fired")
    expect(logic.expireDueTimers(expired.state, 70_000).state).toBe(expired.state)
})

test("pausing cancels the deadline; explicit resume extends the session without restoring speech", () => {
    const paused = logic.pauseSession(speaking(), "user-paused", 3_000).state
    expect(logic.nextAlarmAt(paused)).toBeNull()
    expect(logic.expireDueTimers(paused, 80_000).state).toBe(paused)
    const resumed = logic.resumeSession(paused, 83_000).state
    expect(resumed.floor).toBeNull()
    expect(logic.nextAlarmAt(resumed)).toBe(141_000)
    expect(resumed.contributions[0]?.status).toBe("interrupted")
})
