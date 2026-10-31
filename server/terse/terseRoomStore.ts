import type { RoomStore } from "../seminar/roomStore"
import type { TerseConfig } from "../config/types"
import { subscribeToTerseRoom } from "./roomSubscription"
import type { BoardChangeResult, BoardEditInput, ClaimFloorInput, ClaimFloorResult, EvidenceRequestInput, EvidenceResultInput, EvidenceResultOutcome, FinishUtteranceInput, FinishUtteranceResult, HumanCardInput, HumanContributionInput, HumanContributionResult, InterruptReason, InterruptResult, OpenFloorReason, OpenFloorResult, OutboundEvent, ProposalInput, PublicRoomState, RecoverResult, Reflection, RoomState, RoomTheme, SegmentHeardInput, SegmentHeardResult, StartSessionInput, SubmitProposalResult, TraceInput } from "../../actor/src/roomTypes"

/** Explicit local transport. Never inherits TERSE_API_KEY or another project's endpoint. */
export function createTerseRoomStore(config: TerseConfig): RoomStore {
    const base = new URL(config.actorUrl)
    if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:" || base.username || base.password || base.search || base.hash || !new RegExp("^/v1/projects/[A-Za-z0-9._-]+/actors/?$").test(base.pathname)) throw new Error("Terse must use the explicit local actor endpoint")
    const endpoint = base.toString().endsWith("/") ? base.toString().slice(0, -1) : base.toString()
    async function invoke<T>(roomId: string, method: string, args: unknown[]): Promise<T> {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(roomId) || roomId === "." || roomId === "..") throw new Error("Invalid room id")
        const requestId = crypto.randomUUID()
        const response = await fetch(endpoint + "/SeminarActor/" + encodeURIComponent(roomId) + "/invoke", {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json", "x-request-id": requestId },
            body: JSON.stringify({ requestId, method, args }), signal: AbortSignal.timeout(30_000), redirect: "error",
        })
        if (!response.ok) throw new Error("Terse actor request failed (HTTP " + response.status + ")")
        const document: unknown = await response.json()
        if (!document || typeof document !== "object" || !("outcome" in document)) throw new Error("Invalid Terse response")
        const outcome = document.outcome
        if (!outcome || typeof outcome !== "object" || !("type" in outcome)) throw new Error("Invalid Terse outcome")
        if (outcome.type !== "completed" || !("result" in outcome)) throw new Error("Terse actor operation failed")
        return outcome.result as T
    }
    return {
        subscribe: (roomId, onSnapshot, onError) => {
            if (!/^[A-Za-z0-9._-]{1,128}$/.test(roomId) || roomId === "." || roomId === "..") return Promise.reject(new Error("Invalid room id"))
            return subscribeToTerseRoom(endpoint, roomId, onSnapshot, onError)
        },
        getSnapshot: (roomId: string) => invoke<RoomState>(roomId, "getSnapshot", []),
        startSession: (roomId: string, input: StartSessionInput) => invoke<PublicRoomState>(roomId, "startSession", [input]),
        appendHumanContribution: (roomId: string, input: HumanContributionInput) => invoke<HumanContributionResult>(roomId, "appendHumanContribution", [input]),
        submitProposal: (roomId: string, input: ProposalInput) => invoke<SubmitProposalResult>(roomId, "submitProposal", [input]),
        claimFloor: (roomId: string, input: ClaimFloorInput) => invoke<ClaimFloorResult>(roomId, "claimFloor", [input]),
        markSegmentHeard: (roomId: string, input: SegmentHeardInput) => invoke<SegmentHeardResult>(roomId, "markSegmentHeard", [input]),
        finishUtterance: (roomId: string, input: FinishUtteranceInput) => invoke<FinishUtteranceResult>(roomId, "finishUtterance", [input]),
        interrupt: (roomId: string, reason: InterruptReason) => invoke<InterruptResult>(roomId, "interrupt", [reason]),
        setTheme: (roomId: string, theme: RoomTheme) => invoke<InterruptResult>(roomId, "setTheme", [theme]),
        openFloor: (roomId: string, reason: OpenFloorReason) => invoke<OpenFloorResult>(roomId, "openFloor", [reason]),
        pauseSession: (roomId: string, reason: string) => invoke<InterruptResult>(roomId, "pauseSession", [reason]),
        resumeSession: (roomId: string) => invoke<OpenFloorResult>(roomId, "resumeSession", []),
        beginReflection: (roomId: string, reason: string) => invoke<InterruptResult>(roomId, "beginReflection", [reason]),
        setReflection: async (roomId: string, reflection: Reflection) => { await invoke<unknown>(roomId, "setReflection", [reflection]) },
        recordEvidenceRequest: (roomId: string, input: EvidenceRequestInput) => invoke<{ ok: boolean; duplicate: boolean }>(roomId, "recordEvidenceRequest", [input]),
        recordEvidenceResult: (roomId: string, input: EvidenceResultInput) => invoke<EvidenceResultOutcome>(roomId, "recordEvidenceResult", [input]),
        editBoardCard: (roomId: string, input: BoardEditInput) => invoke<BoardChangeResult>(roomId, "editBoardCard", [input]),
        addHumanCard: (roomId: string, input: HumanCardInput) => invoke<BoardChangeResult>(roomId, "addHumanCard", [input]),
        setContributionRelayMessageId: async (roomId: string, contributionId: string, relayMessageId: string) => { await invoke<unknown>(roomId, "setContributionRelayMessageId", [contributionId, relayMessageId]) },
        markEventProcessed: (roomId: string, consumer: string, eventId: string) => invoke<boolean>(roomId, "markEventProcessed", [consumer, eventId]),
        enqueueOutbound: async (roomId: string, event: OutboundEvent) => { await invoke<unknown>(roomId, "enqueueOutbound", [event]) },
        markOutboundSent: async (roomId: string, eventId: string) => { await invoke<unknown>(roomId, "markOutboundSent", [eventId]) },
        appendTrace: async (roomId: string, entries: TraceInput[]) => { await invoke<unknown>(roomId, "appendTrace", [entries]) },
        recoverAfterRestart: (roomId: string) => invoke<RecoverResult>(roomId, "recoverAfterRestart", []),
    }
}

