import type { RoomStore } from "./roomStore"
import * as logic from "../../actor/src/roomLogic"
import type { BoardChangeResult, BoardEditInput, ClaimFloorInput, ClaimFloorResult, EvidenceRequestInput, EvidenceResultInput, EvidenceResultOutcome, FinishUtteranceInput, FinishUtteranceResult, HumanCardInput, HumanContributionInput, HumanContributionResult, InterruptReason, InterruptResult, OpenFloorReason, OpenFloorResult, OutboundEvent, ProposalInput, PublicRoomState, RecoverResult, Reflection, RoomState, RoomTheme, SegmentHeardInput, SegmentHeardResult, StartSessionInput, SubmitProposalResult, TraceInput } from "../../actor/src/roomTypes"

/** Test fixture only. Uses the same pure transitions as the actual Terse actor. */
export function createMemoryRoomStore(clock: () => number = Date.now): RoomStore {
    const rooms = new Map<string, RoomState>()
    const get = (id: string) => rooms.get(id) ?? logic.emptyRoomState(id, clock())
    return {
        async getSnapshot(roomId: string): Promise<RoomState> { return structuredClone(get(roomId)) },
        async startSession(roomId: string, input: StartSessionInput): Promise<PublicRoomState> {
            const next = logic.startSession(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async appendHumanContribution(roomId: string, input: HumanContributionInput): Promise<HumanContributionResult> {
            const next = logic.appendHumanContribution(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async submitProposal(roomId: string, input: ProposalInput): Promise<SubmitProposalResult> {
            const next = logic.submitProposal(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async claimFloor(roomId: string, input: ClaimFloorInput): Promise<ClaimFloorResult> {
            const next = logic.claimFloor(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async markSegmentHeard(roomId: string, input: SegmentHeardInput): Promise<SegmentHeardResult> {
            const next = logic.markSegmentHeard(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async finishUtterance(roomId: string, input: FinishUtteranceInput): Promise<FinishUtteranceResult> {
            const next = logic.finishUtterance(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async interrupt(roomId: string, reason: InterruptReason): Promise<InterruptResult> {
            const next = logic.interrupt(get(roomId), reason, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async openFloor(roomId: string, reason: OpenFloorReason): Promise<OpenFloorResult> {
            const next = logic.openFloor(get(roomId), reason, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async setTheme(roomId: string, theme: RoomTheme): Promise<InterruptResult> {
            const next = logic.setTheme(get(roomId), theme, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async pauseSession(roomId: string, reason: string): Promise<InterruptResult> {
            const next = logic.pauseSession(get(roomId), reason, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async resumeSession(roomId: string): Promise<OpenFloorResult> {
            const next = logic.resumeSession(get(roomId), clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async beginReflection(roomId: string, reason: string): Promise<InterruptResult> {
            const next = logic.beginReflection(get(roomId), reason, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async setReflection(roomId: string, reflection: Reflection): Promise<void> {
            const next = logic.setReflection(get(roomId), reflection, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async recordEvidenceRequest(roomId: string, input: EvidenceRequestInput): Promise<{ ok: boolean; duplicate: boolean }> {
            const next = logic.recordEvidenceRequest(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async recordEvidenceResult(roomId: string, input: EvidenceResultInput): Promise<EvidenceResultOutcome> {
            const next = logic.recordEvidenceResult(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async editBoardCard(roomId: string, input: BoardEditInput): Promise<BoardChangeResult> {
            const next = logic.editBoardCard(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async addHumanCard(roomId: string, input: HumanCardInput): Promise<BoardChangeResult> {
            const next = logic.addHumanCard(get(roomId), input, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async setContributionRelayMessageId(roomId: string, contributionId: string, relayMessageId: string): Promise<void> {
            const next = logic.setContributionRelayMessageId(get(roomId), contributionId, relayMessageId, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async markEventProcessed(roomId: string, consumer: string, eventId: string): Promise<boolean> {
            const next = logic.markEventProcessed(get(roomId), consumer, eventId, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async enqueueOutbound(roomId: string, event: OutboundEvent): Promise<void> {
            const next = logic.enqueueOutbound(get(roomId), event, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async markOutboundSent(roomId: string, eventId: string): Promise<void> {
            const next = logic.markOutboundSent(get(roomId), eventId, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async appendTrace(roomId: string, entries: TraceInput[]): Promise<void> {
            const next = logic.appendTrace(get(roomId), entries, clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
        async recoverAfterRestart(roomId: string): Promise<RecoverResult> {
            const next = logic.recoverAfterRestart(get(roomId), clock())
            rooms.set(roomId, next.state)
            return structuredClone(next.result)
        },
    }
}

