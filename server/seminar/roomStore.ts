// RoomStore: the backend's view of the authoritative SeminarActor.
//
// Implementations:
//   server/terse/terseRoomStore.ts  — explicit HTTP actor transport from config (live).
//   server/seminar/memoryRoomStore.ts — wraps actor/src/roomLogic.ts directly (tests only).
// Both MUST behave identically because the actor itself only delegates to roomLogic.
//
// Every method is a short state transition. Never hold model/network work inside an actor call.

import type {
    BoardChangeResult,
    BoardEditInput,
    ClaimFloorInput,
    ClaimFloorResult,
    EvidenceRequestInput,
    EvidenceResultInput,
    EvidenceResultOutcome,
    FinishUtteranceInput,
    FinishUtteranceResult,
    HumanCardInput,
    HumanContributionInput,
    HumanContributionResult,
    InterruptReason,
    InterruptResult,
    OpenFloorReason,
    OpenFloorResult,
    OutboundEvent,
    ProposalInput,
    PublicRoomState,
    RecoverResult,
    Reflection,
    RoomState,
    RoomTheme,
    SegmentHeardInput,
    SegmentHeardResult,
    StartSessionInput,
    SubmitProposalResult,
    TraceInput,
} from "../../actor/src/roomTypes"

export interface RoomStore {
    /** Backend-only push of public actor state. Implementations may reconnect; unsubscribe closes it. */
    subscribe?(roomId: string, onSnapshot: (state: PublicRoomState) => void, onError?: (error: Error) => void): Promise<() => void>
    startSession(roomId: string, input: StartSessionInput): Promise<PublicRoomState>
    getSnapshot(roomId: string): Promise<RoomState>
    appendHumanContribution(roomId: string, input: HumanContributionInput): Promise<HumanContributionResult>
    submitProposal(roomId: string, input: ProposalInput): Promise<SubmitProposalResult>
    claimFloor(roomId: string, input: ClaimFloorInput): Promise<ClaimFloorResult>
    markSegmentHeard(roomId: string, input: SegmentHeardInput): Promise<SegmentHeardResult>
    finishUtterance(roomId: string, input: FinishUtteranceInput): Promise<FinishUtteranceResult>
    interrupt(roomId: string, reason: InterruptReason): Promise<InterruptResult>
    /** Updates presentation; active work is revoked, phase and human-floor ownership preserved. */
    setTheme(roomId: string, theme: RoomTheme): Promise<InterruptResult>
    openFloor(roomId: string, reason: OpenFloorReason): Promise<OpenFloorResult>
    pauseSession(roomId: string, reason: string): Promise<InterruptResult>
    resumeSession(roomId: string): Promise<OpenFloorResult>
    beginReflection(roomId: string, reason: string): Promise<InterruptResult>
    setReflection(roomId: string, reflection: Reflection): Promise<void>
    recordEvidenceRequest(roomId: string, input: EvidenceRequestInput): Promise<{ ok: boolean; duplicate: boolean }>
    recordEvidenceResult(roomId: string, input: EvidenceResultInput): Promise<EvidenceResultOutcome>
    editBoardCard(roomId: string, input: BoardEditInput): Promise<BoardChangeResult>
    addHumanCard(roomId: string, input: HumanCardInput): Promise<BoardChangeResult>
    setContributionRelayMessageId(roomId: string, contributionId: string, relayMessageId: string): Promise<void>
    /** Returns true the first time `${consumer}:${eventId}` is seen, false for duplicates. */
    markEventProcessed(roomId: string, consumer: string, eventId: string): Promise<boolean>
    enqueueOutbound(roomId: string, event: OutboundEvent): Promise<void>
    markOutboundSent(roomId: string, eventId: string): Promise<void>
    appendTrace(roomId: string, entries: TraceInput[]): Promise<void>
    /** Expire stale leases, advance the epoch and force `paused` (explicit resume required). */
    recoverAfterRestart(roomId: string): Promise<RecoverResult>
}
