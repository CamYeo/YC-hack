import { Actor, Persisted, type ActorSocket } from "terse-sdk/actor"
import * as logic from "./roomLogic"
import type { BoardChangeResult, BoardEditInput, ClaimFloorInput, ClaimFloorResult, EvidenceRequestInput, EvidenceResultInput, EvidenceResultOutcome, FinishUtteranceInput, FinishUtteranceResult, HumanCardInput, HumanContributionInput, HumanContributionResult, InterruptReason, InterruptResult, OpenFloorReason, OpenFloorResult, OutboundEvent, ProposalInput, PublicRoomState, RecoverResult, Reflection, RoomState, RoomTheme, SegmentHeardInput, SegmentHeardResult, StartSessionInput, SubmitProposalResult, TraceInput } from "./roomTypes"

type WatchMetadata = { role: "backend" }
type SnapshotEvent = { type: "snapshot"; state: PublicRoomState }

/** One durable actor owns every transition, lease, and cancellation epoch for a room. */
export class SeminarActor extends Actor<WatchMetadata, null, SnapshotEvent> {
    @Persisted
    private room: RoomState = logic.emptyRoomState(this.id)

    async getSnapshot(): Promise<RoomState> { return structuredClone(this.room) }

    async onConnect(socket: ActorSocket<WatchMetadata, SnapshotEvent>): Promise<void> {
        socket.send({ type: "snapshot", state: logic.publicSnapshot(this.room) })
    }

    async onAlarm(): Promise<void> {
        const next = logic.expireDueTimers(this.room, Date.now())
        await this.commit(next.state)
    }

    private async commit(state: RoomState): Promise<void> {
        const changed = state !== this.room
        await this.db.transaction(async () => {
            this.room = state
            const at = logic.nextAlarmAt(state)
            if (at === null) this.alarm.delete()
            else this.alarm.set(at)
        })
        // A stale early alarm must still re-arm the current deadline, but needs no snapshot.
        if (changed) this.broadcast({ type: "snapshot", state: logic.publicSnapshot(state) })
    }

    async startSession(input: StartSessionInput): Promise<PublicRoomState> {
        const next = logic.startSession(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async appendHumanContribution(input: HumanContributionInput): Promise<HumanContributionResult> {
        const next = logic.appendHumanContribution(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async submitProposal(input: ProposalInput): Promise<SubmitProposalResult> {
        const next = logic.submitProposal(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async claimFloor(input: ClaimFloorInput): Promise<ClaimFloorResult> {
        const next = logic.claimFloor(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async markSegmentHeard(input: SegmentHeardInput): Promise<SegmentHeardResult> {
        const next = logic.markSegmentHeard(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async finishUtterance(input: FinishUtteranceInput): Promise<FinishUtteranceResult> {
        const next = logic.finishUtterance(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async interrupt(reason: InterruptReason): Promise<InterruptResult> {
        const next = logic.interrupt(this.room, reason, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async openFloor(reason: OpenFloorReason): Promise<OpenFloorResult> {
        const next = logic.openFloor(this.room, reason, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async setTheme(theme: RoomTheme): Promise<InterruptResult> {
        const next = logic.setTheme(this.room, theme, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async pauseSession(reason: string): Promise<InterruptResult> {
        const next = logic.pauseSession(this.room, reason, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async resumeSession(): Promise<OpenFloorResult> {
        const next = logic.resumeSession(this.room, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async beginReflection(reason: string): Promise<InterruptResult> {
        const next = logic.beginReflection(this.room, reason, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async setReflection(reflection: Reflection): Promise<void> {
        const next = logic.setReflection(this.room, reflection, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async recordEvidenceRequest(input: EvidenceRequestInput): Promise<{ ok: boolean; duplicate: boolean }> {
        const next = logic.recordEvidenceRequest(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async recordEvidenceResult(input: EvidenceResultInput): Promise<EvidenceResultOutcome> {
        const next = logic.recordEvidenceResult(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async editBoardCard(input: BoardEditInput): Promise<BoardChangeResult> {
        const next = logic.editBoardCard(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async addHumanCard(input: HumanCardInput): Promise<BoardChangeResult> {
        const next = logic.addHumanCard(this.room, input, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async setContributionRelayMessageId(contributionId: string, relayMessageId: string): Promise<void> {
        const next = logic.setContributionRelayMessageId(this.room, contributionId, relayMessageId, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async markEventProcessed(consumer: string, eventId: string): Promise<boolean> {
        const next = logic.markEventProcessed(this.room, consumer, eventId, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async enqueueOutbound(event: OutboundEvent): Promise<void> {
        const next = logic.enqueueOutbound(this.room, event, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async markOutboundSent(eventId: string): Promise<void> {
        const next = logic.markOutboundSent(this.room, eventId, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async appendTrace(entries: TraceInput[]): Promise<void> {
        const next = logic.appendTrace(this.room, entries, Date.now())
        await this.commit(next.state)
        return next.result
    }

    async recoverAfterRestart(): Promise<RecoverResult> {
        const next = logic.recoverAfterRestart(this.room, Date.now())
        await this.commit(next.state)
        return next.result
    }

}

