import type {
    BoardCard, BoardChangeResult, BoardEditInput, ClaimFloorInput, ClaimFloorResult,
    Contribution, EvidenceRecord, EvidenceRequestInput, EvidenceResultInput, EvidenceResultOutcome,
    FinishUtteranceInput, FinishUtteranceResult, HumanCardInput, HumanContributionInput,
    HumanContributionResult, InterruptReason, InterruptResult, OpenFloorReason, OpenFloorResult,
    OutboundEvent, PendingProposal, ProposalInput, PublicRoomState, RecoverResult, Reflection,
    RoomState, RoomTheme, SegmentHeardInput, SegmentHeardResult, SpeakerId, StartSessionInput,
    SubmitProposalResult, TraceInput, TurnHint,
} from "./roomTypes"

export interface Transition<T> { state: RoomState; result: T }
const boundedLease = (ms: number) => Math.max(5_000, Math.min(120_000, Number.isFinite(ms) ? ms : 15_000))
const clone = (s: RoomState): RoomState => structuredClone(s)
const answer = <T>(state: RoomState, result: T): Transition<T> => ({ state, result })
const isHeard = (c: Contribution) => (c.status === "human" || c.status === "heard" || c.status === "interrupted") && c.heardText.length > 0
const lastHeard = (s: RoomState) => [...s.contributions].reverse().find(isHeard)
const peer = (id: string | null): SpeakerId => id === "maya" ? "theo" : "maya"
const pendingWinner = (s: RoomState) => s.floor ? s.pendingProposals.filter(p => p.proposalId === s.floor?.proposalId) : []

export function emptyRoomState(roomId = "", now = Date.now()): RoomState {
    return {
        roomId, sessionId: "", config: null, phase: "paused", pauseReason: "not-started", version: 0,
        generationEpoch: 0, contributions: [], board: [], floor: null, pendingProposals: [], evidence: [],
        turn: { peerStreak: 0, awaitingHuman: false, invitedAt: null, lastSpeakerId: null,
            speakerCounts: { facilitator: 0, maya: 0, theo: 0 }, debateStage: null, stageTurns: 0,
            hint: { mode: "closed", preferredSpeakers: [], requiredAddressee: null, debateStage: null, reason: "Room has not started" } },
        budget: { startedAt: now, endsAt: now, aiTurnsUsed: 0, maxAiTurns: 0, generationCalls: 0, maxGenerationCalls: 0 },
        reflection: null, trace: [], processedEventKeys: [], pendingOutbound: [],
        counters: { contribution: 0, card: 0, trace: 0 }, createdAt: now, updatedAt: now,
    }
}

/** Public snapshots intentionally omit delivery bookkeeping. */
export function publicSnapshot(s: RoomState): PublicRoomState {
    const { processedEventKeys: _events, pendingOutbound: _outbox, ...visible } = clone(s)
    return visible
}

export function computeTurnHint(s: RoomState, now = Date.now()): TurnHint {
    const base = { requiredAddressee: null, debateStage: s.turn.debateStage } as const
    if (s.phase !== "discussion" || !s.config) return { ...base, mode: "closed", preferredSpeakers: [], reason: "Discussion is paused or ended" }
    if (s.turn.awaitingHuman) return { ...base, mode: "await-human", preferredSpeakers: [], requiredAddressee: "human", reason: "The learner has the floor" }
    if (s.budget.aiTurnsUsed >= s.budget.maxAiTurns - 1 || now >= s.budget.endsAt - 45_000 || s.turn.debateStage === "closing") {
        return { ...base, mode: "wrap-up", preferredSpeakers: ["facilitator"], reason: "Close with an unresolved question" }
    }
    const last = lastHeard(s)
    if (!last) return { ...base, mode: "open", preferredSpeakers: ["facilitator"], reason: "Frame the opening question" }
    const freshEvidence = [...s.evidence].reverse().find(e => e.status === "returned" && !e.discussed)
    if (freshEvidence) return { ...base, mode: "respond-to-evidence", preferredSpeakers: freshEvidence.requestedBy === "maya" ? ["theo", "maya"] : ["maya", "theo"], reason: "Discuss the actual evidence and its limits" }
    if (last.speakerId === "human") {
        const replied = s.contributions.find(c => c.id === last.replyToContributionId)
        const target = last.addressedTo === "maya" || last.addressedTo === "theo" ? last.addressedTo
            : replied?.speakerId === "maya" || replied?.speakerId === "theo" ? replied.speakerId
            : s.turn.speakerCounts.maya <= s.turn.speakerCounts.theo ? "maya" : "theo"
        return { ...base, mode: "respond-to-human", preferredSpeakers: [target], reason: "Engage directly with the learner's contribution" }
    }
    if (s.config.participation === "lead") return { ...base, mode: "invite-human", preferredSpeakers: ["facilitator"], requiredAddressee: "human", reason: "The learner leads this discussion" }
    if (s.turn.peerStreak >= s.config.aiTurnsBeforeInvite) return { ...base, mode: "invite-human", preferredSpeakers: ["facilitator"], requiredAddressee: "human", reason: "Make room for the learner" }
    const target = last.addressedTo === "maya" || last.addressedTo === "theo" ? last.addressedTo : peer(last.speakerId)
    return { ...base, mode: "peer-exchange", preferredSpeakers: [target], reason: "Respond to the other participant's reasoning" }
}

function refresh(s: RoomState, now: number): void { s.updatedAt = now; s.turn.hint = computeTurnHint(s, now) }
function dedupe(s: RoomState, key: string): boolean {
    if (s.processedEventKeys.includes(key)) return false
    s.processedEventKeys = [...s.processedEventKeys, key].slice(-6000)
    return true
}
function bump(s: RoomState, now: number): void { s.version++; s.updatedAt = now; s.pendingProposals = pendingWinner(s) }
function addCard(s: RoomState, card: Omit<BoardCard, "id">): BoardCard {
    const result = { ...card, id: `card-${++s.counters.card}` }
    s.board = [...s.board, result]
    return result
}

/** Revoke only the live lease; never promote the unheard suffix into shared context. */
function revoke(s: RoomState, now: number): Contribution | null {
    const active = s.floor && s.contributions.find(c => c.id === s.floor?.contributionId && c.status === "speaking")
    let interrupted: Contribution | null = null
    if (active) {
        const stopped: Contribution = { ...active, status: "interrupted", completedAt: now }
        interrupted = stopped
        s.contributions = s.contributions.map(c => c.id === active.id ? stopped : c)
    }
    s.floor = null
    s.pendingProposals = []
    return interrupted
}

export function startSession(old: RoomState, input: StartSessionInput, now = Date.now()): Transition<PublicRoomState> {
    if (old.sessionId === input.sessionId && old.config) return answer(old, publicSnapshot(old))
    const s = emptyRoomState(input.roomId, now)
    s.sessionId = input.sessionId; s.config = { ...structuredClone(input.config), theme: input.config.theme ?? "classroom" }; s.phase = "discussion"; s.pauseReason = null
    s.version = old.version + 1; s.generationEpoch = old.generationEpoch + 1
    s.turn.debateStage = input.config.format === "debate" ? "opening" : null
    s.budget = { startedAt: now, endsAt: now + Math.max(1, input.config.sessionMinutes) * 60_000,
        aiTurnsUsed: 0, maxAiTurns: input.config.maxAiTurns, generationCalls: 0, maxGenerationCalls: input.config.maxGenerationCalls }
    refresh(s, now)
    return answer(s, publicSnapshot(s))
}

export function appendHumanContribution(old: RoomState, input: HumanContributionInput, now = Date.now()): Transition<HumanContributionResult> {
    if (old.phase !== "discussion") return answer(old, { ok: false, reason: "not-accepting" })
    if (!input.text.trim()) return answer(old, { ok: false, reason: "empty" })
    if (old.processedEventKeys.includes(`human:${input.eventId}`)) return answer(old, { ok: false, reason: "duplicate" })
    const correction = input.correctionOf ? old.contributions.find(c => c.id === input.correctionOf && c.status === "human" && c.speakerId === "human") : null
    if (input.correctionOf && !correction) return answer(old, { ok: false, reason: "invalid-correction" })
    const s = clone(old); const interrupted = revoke(s, now)
    // All in-flight proposals must be invalidated even when no audio was playing.
    s.generationEpoch++; dedupe(s, `human:${input.eventId}`)
    const text = input.text.trim()
    const c: Contribution = {
        id: `c-${++s.counters.contribution}`, speakerId: "human", replyToContributionId: input.replyToContributionId && s.contributions.some(x => x.id === input.replyToContributionId && isHeard(x)) ? input.replyToContributionId : null,
        addressedTo: input.addressedTo, generatedText: text, heardText: text, segments: [text], segmentsHeard: 1,
        status: "human", sourceIds: [], utteranceId: null, proposalId: null, generationEpoch: s.generationEpoch,
        inputMode: input.inputMode, correctionOf: input.correctionOf, relayMessageId: null, eventId: input.eventId, createdAt: now, completedAt: now,
    }
    if (correction) {
        s.contributions = s.contributions.map(x => x.id === correction.id ? { ...x, status: "superseded" } : x)
        const dependentIds = new Set([correction.id])
        for (const item of s.contributions) if (item.replyToContributionId && dependentIds.has(item.replyToContributionId)) dependentIds.add(item.id)
        s.board = s.board.map(card => card.supportingContributionIds.some(id => dependentIds.has(id)) || (card.promptedBy && dependentIds.has(card.promptedBy.contributionId)) ? { ...card, status: "stale", updatedAt: now } : card)
    }
    s.contributions = [...s.contributions, c]
    s.turn.peerStreak = 0; s.turn.awaitingHuman = false; s.turn.invitedAt = null; s.turn.lastSpeakerId = "human"
    bump(s, now); refresh(s, now)
    return answer(s, { ok: true, contribution: c, hint: s.turn.hint, version: s.version, interrupted })
}

export function submitProposal(old: RoomState, input: ProposalInput, now = Date.now()): Transition<SubmitProposalResult> {
    if (old.sessionId !== input.sessionId) return answer(old, { ok: false, reason: "wrong-session" })
    if (old.generationEpoch !== input.generationEpoch) return answer(old, { ok: false, reason: "stale-epoch" })
    if (old.version !== input.basedOnRoomVersion) return answer(old, { ok: false, reason: "stale-version" })
    if (old.phase !== "discussion" || old.floor || old.turn.awaitingHuman) return answer(old, { ok: false, reason: "not-accepting" })
    if (old.pendingProposals.some(p => p.proposalId === input.proposalId) || old.processedEventKeys.includes(`proposal:${input.eventId}`)) return answer(old, { ok: false, reason: "duplicate" })
    if (old.budget.generationCalls >= old.budget.maxGenerationCalls || old.budget.aiTurnsUsed >= old.budget.maxAiTurns || now >= old.budget.endsAt) return answer(old, { ok: false, reason: "budget-exhausted" })
    if (input.replyToContributionId && !old.contributions.some(c => c.id === input.replyToContributionId && isHeard(c))) return answer(old, { ok: false, reason: "invalid-reference" })
    if (input.boardUpdate?.targetCardId && !old.board.some(c => c.id === input.boardUpdate?.targetCardId)) return answer(old, { ok: false, reason: "invalid-reference" })
    if (input.boardUpdate?.attributeToHumanContributionId && !old.contributions.some(c => c.id === input.boardUpdate?.attributeToHumanContributionId && c.status === "human" && c.speakerId === "human")) return answer(old, { ok: false, reason: "invalid-reference" })
    const s = clone(old)
    dedupe(s, `proposal:${input.eventId}`); s.budget.generationCalls++
    const { sessionId: _sessionId, ...proposal } = input
    s.pendingProposals = [...s.pendingProposals, { ...structuredClone(proposal), receivedAt: now }]
    s.updatedAt = now
    return answer(s, { ok: true, pendingCount: s.pendingProposals.length })
}

export function claimFloor(old: RoomState, input: ClaimFloorInput, now = Date.now()): Transition<ClaimFloorResult> {
    if (old.phase !== "discussion") return answer(old, { ok: false, reason: "not-in-discussion" })
    if (old.floor) return answer(old, { ok: false, reason: "floor-busy" })
    if (old.turn.awaitingHuman) return answer(old, { ok: false, reason: "awaiting-human" })
    if (now >= old.budget.endsAt) return answer(old, { ok: false, reason: "time-up" })
    if (old.budget.aiTurnsUsed >= old.budget.maxAiTurns) return answer(old, { ok: false, reason: "budget-exhausted" })
    const p = old.pendingProposals.find(item => item.proposalId === input.proposalId && item.action !== "yield")
    if (!p || !input.segments.length || input.segments.join(" ").replace(/\s+/g, " ").trim() !== p.text.replace(/\s+/g, " ").trim()) return answer(old, { ok: false, reason: "unknown-proposal" })
    if (p.generationEpoch !== old.generationEpoch) return answer(old, { ok: false, reason: "stale-epoch" })
    if (p.basedOnRoomVersion !== old.version) return answer(old, { ok: false, reason: "stale-version" })
    if (old.turn.hint.requiredAddressee && old.turn.hint.requiredAddressee !== p.addressedTo) return answer(old, { ok: false, reason: "addressee-required" })
    const s = clone(old)
    const c: Contribution = {
        id: `c-${++s.counters.contribution}`, speakerId: p.speakerId, replyToContributionId: p.replyToContributionId,
        addressedTo: p.addressedTo, generatedText: p.text, heardText: "", segments: [...input.segments], segmentsHeard: 0,
        status: "speaking", sourceIds: [...p.sourceIds], utteranceId: input.utteranceId, proposalId: p.proposalId,
        generationEpoch: s.generationEpoch, inputMode: "ai", correctionOf: null, relayMessageId: null,
        eventId: p.eventId, createdAt: now, completedAt: null,
    }
    s.contributions = [...s.contributions, c]
    s.floor = { speakerId: p.speakerId, utteranceId: input.utteranceId, contributionId: c.id,
        proposalId: p.proposalId, generationEpoch: s.generationEpoch, grantedAt: now, expiresAt: now + boundedLease(input.leaseMs) }
    s.pendingProposals = [p]; s.updatedAt = now
    return answer(s, { ok: true, lease: s.floor, contribution: c })
}

export function markSegmentHeard(old: RoomState, input: SegmentHeardInput, now = Date.now()): Transition<SegmentHeardResult> {
    const c = old.contributions.find(item => item.utteranceId === input.utteranceId)
    if (!c) return answer(old, { ok: false, reason: "unknown-utterance" })
    if (!old.floor || old.floor.utteranceId !== input.utteranceId || old.floor.generationEpoch !== old.generationEpoch || c.status !== "speaking" || old.floor.expiresAt <= now) return answer(old, { ok: false, reason: "not-speaking" })
    if (!Number.isInteger(input.segmentIndex) || input.segmentIndex < 0 || input.segmentIndex >= c.segments.length || input.segmentIndex > c.segmentsHeard) return answer(old, { ok: false, reason: "out-of-order" })
    if (input.segmentIndex < c.segmentsHeard) return answer(old, { ok: true, segmentsHeard: c.segmentsHeard, heardText: c.heardText })
    const s = clone(old)
    const segmentsHeard = c.segmentsHeard + 1; const heardText = c.segments.slice(0, segmentsHeard).join(" ")
    s.contributions = s.contributions.map(item => item.id === c.id ? { ...item, segmentsHeard, heardText } : item)
    s.floor = { ...old.floor, expiresAt: now + boundedLease(input.leaseMs) }; s.updatedAt = now
    return answer(s, { ok: true, segmentsHeard, heardText })
}

function applyBoardUpdate(s: RoomState, p: PendingProposal, c: Contribution, now: number): string[] {
    const update = p.boardUpdate
    if (!update) return []
    const human = update.attributeToHumanContributionId && s.contributions.find(item => item.id === update.attributeToHumanContributionId && item.speakerId === "human" && item.status === "human")
    if (update.attributeToHumanContributionId && !human) return []
    const replied = c.replyToContributionId && s.contributions.find(item => item.id === c.replyToContributionId)
    // Human dismissal wins even if it occurs after the proposal was approved for speech.
    const target = update.targetCardId && s.board.find(card => card.id === update.targetCardId && card.status !== "dismissed")
    const card = addCard(s, {
        kind: update.kind, text: update.text, authorId: human ? "human" : c.speakerId, summarizedBy: human ? c.speakerId : null,
        supportingContributionIds: human ? [human.id, c.id] : [c.id], sourceIds: [...c.sourceIds], evidenceIds: [],
        relations: target && update.relation ? [{ type: update.relation, targetCardId: target.id }] : [],
        status: update.kind === "question" ? "unresolved" : "proposed",
        promptedBy: replied ? { participantId: replied.speakerId, contributionId: replied.id } : null,
        editedByHuman: false, createdAt: now, updatedAt: now,
    })
    if (target && update.relation === "challenges") s.board = s.board.map(item => item.id === target.id ? { ...item, status: "contested", updatedAt: now } : item)
    return [card.id]
}

export function finishUtterance(old: RoomState, input: FinishUtteranceInput, now = Date.now()): Transition<FinishUtteranceResult> {
    const current = old.contributions.find(c => c.utteranceId === input.utteranceId)
    if (!current) return answer(old, { ok: false, reason: "unknown-utterance" })
    if (current.status !== "speaking" || old.floor?.utteranceId !== input.utteranceId) return answer(old, { ok: false, reason: "already-finished" })
    const s = clone(old); const p = s.pendingProposals.find(item => item.proposalId === current.proposalId)
    const fullyHeard = input.outcome === "completed" && current.segmentsHeard === current.segments.length && current.segments.length > 0 && old.floor.expiresAt > now
    const c: Contribution = { ...current, status: fullyHeard ? "heard" : "interrupted", completedAt: now }
    const precedingHint = s.turn.hint.mode
    s.contributions = s.contributions.map(item => item.id === c.id ? c : item)
    const boardCardIds = fullyHeard && p ? applyBoardUpdate(s, p, c, now) : []
    s.floor = null; s.pendingProposals = []
    if (fullyHeard) {
        s.budget.aiTurnsUsed++
        if (c.speakerId === "facilitator" || c.speakerId === "maya" || c.speakerId === "theo") s.turn.speakerCounts[c.speakerId]++
        s.turn.lastSpeakerId = c.speakerId
        if (c.speakerId === "maya" || c.speakerId === "theo") s.turn.peerStreak++
        s.turn.stageTurns++
        if (s.config?.format === "debate") {
            if (s.turn.debateStage === "opening" && s.turn.stageTurns >= 3) { s.turn.debateStage = "cross-examination"; s.turn.stageTurns = 0 }
            else if (s.turn.debateStage === "cross-examination" && s.turn.stageTurns >= 4) { s.turn.debateStage = "rebuttal"; s.turn.stageTurns = 0 }
            else if (s.turn.debateStage === "rebuttal" && s.turn.stageTurns >= 2) { s.turn.debateStage = "closing"; s.turn.stageTurns = 0 }
        }
        if ((precedingHint === "invite-human" && c.addressedTo === "human") || s.config?.participation === "lead") {
            s.turn.awaitingHuman = true; s.turn.invitedAt = now
        }
        if (precedingHint === "respond-to-evidence") s.evidence = s.evidence.map(e => e.status === "returned" && !e.discussed ? { ...e, discussed: true } : e)
    } else {
        s.generationEpoch++
        s.turn.awaitingHuman = true; s.turn.invitedAt = now
    }
    bump(s, now); refresh(s, now)
    return answer(s, { ok: true, contribution: c, hint: s.turn.hint, version: s.version, boardCardIds })
}

export function interrupt(old: RoomState, reason: InterruptReason, now = Date.now()): Transition<InterruptResult> {
    const s = clone(old); const interrupted = revoke(s, now)
    s.generationEpoch++; s.version++; s.turn.awaitingHuman = true; s.turn.invitedAt = now
    if (reason === "relay-failure" || reason === "provider-failure") { s.phase = "paused"; s.pauseReason = reason }
    refresh(s, now)
    return answer(s, { generationEpoch: s.generationEpoch, version: s.version, interrupted })
}

/** Presentation changes invalidate active work without changing who owns the next turn. */
export function setTheme(old: RoomState, theme: RoomTheme, now = Date.now()): Transition<InterruptResult> {
    if (theme !== "classroom" && theme !== "halloween") throw new Error("Unknown room theme")
    if (!old.config || (old.config.theme ?? "classroom") === theme) {
        return answer(old, { generationEpoch: old.generationEpoch, version: old.version, interrupted: null })
    }
    const s = clone(old)
    s.config = { ...old.config, theme }
    const interrupted = s.phase === "discussion" ? revoke(s, now) : null
    if (s.phase === "discussion") s.generationEpoch++
    // Resume calculates its remaining paused duration from updatedAt. Preserve elapsed paused
    // time when this non-resuming setting change advances that timestamp.
    if (s.phase === "paused") s.budget.endsAt += Math.max(0, now - old.updatedAt)
    bump(s, now); refresh(s, now)
    return answer(s, { generationEpoch: s.generationEpoch, version: s.version, interrupted })
}

export function openFloor(old: RoomState, reason: OpenFloorReason, now = Date.now()): Transition<OpenFloorResult> {
    if (old.phase !== "discussion" || old.floor) return answer(old, { ok: false, hint: old.turn.hint, version: old.version })
    const s = clone(old)
    s.turn.awaitingHuman = false; s.turn.invitedAt = null
    if (reason === "human-pass" || reason === "await-timeout") s.turn.peerStreak = 0
    bump(s, now); refresh(s, now)
    if ((reason === "human-pass" || reason === "await-timeout") && s.turn.hint.mode === "invite-human") {
        s.turn.hint = { ...s.turn.hint, mode: "peer-exchange", preferredSpeakers: [peer(s.turn.lastSpeakerId)], requiredAddressee: null, reason: "Learner asked peers to continue" }
    }
    return answer(s, { ok: true, hint: s.turn.hint, version: s.version })
}

export function pauseSession(old: RoomState, reason: string, now = Date.now()): Transition<InterruptResult> {
    if (old.phase === "ended" || old.phase === "reflection") return answer(old, { generationEpoch: old.generationEpoch, version: old.version, interrupted: null })
    const s = clone(old); const interrupted = revoke(s, now)
    s.phase = "paused"; s.pauseReason = reason; s.generationEpoch++; s.version++
    refresh(s, now)
    return answer(s, { generationEpoch: s.generationEpoch, version: s.version, interrupted })
}

export function resumeSession(old: RoomState, now = Date.now()): Transition<OpenFloorResult> {
    if (old.phase !== "paused" || !old.config) return answer(old, { ok: false, hint: old.turn.hint, version: old.version })
    const s = clone(old)
    const pausedDuration = Math.max(0, now - old.updatedAt)
    s.budget.endsAt += pausedDuration; s.phase = "discussion"; s.pauseReason = null
    s.turn.awaitingHuman = false; s.turn.invitedAt = null; s.turn.peerStreak = 0
    s.generationEpoch++; bump(s, now); refresh(s, now)
    return answer(s, { ok: true, hint: s.turn.hint, version: s.version })
}

export function beginReflection(old: RoomState, reason: string, now = Date.now()): Transition<InterruptResult> {
    if (old.phase === "ended" || old.phase === "reflection") return answer(old, { generationEpoch: old.generationEpoch, version: old.version, interrupted: null })
    const s = clone(old); const interrupted = revoke(s, now)
    s.phase = "reflection"; s.pauseReason = reason; s.generationEpoch++; s.version++
    refresh(s, now)
    return answer(s, { generationEpoch: s.generationEpoch, version: s.version, interrupted })
}

/** The single durable alarm always tracks the earliest authoritative deadline. */
export function nextAlarmAt(state: RoomState): number | null {
    if (state.phase !== "discussion" || !state.config) return null
    return Math.trunc(state.floor ? Math.min(state.floor.expiresAt, state.budget.endsAt) : state.budget.endsAt)
}

/** Idempotent even if a renewed lease leaves an older alarm delivery in flight. */
export function expireDueTimers(old: RoomState, now = Date.now()): Transition<InterruptResult | null> {
    if (old.phase !== "discussion" || !old.config) return answer(old, null)
    const reason = old.budget.endsAt <= now ? "session-timeout"
        : old.floor && old.floor.expiresAt <= now ? "speaker-timeout" : null
    if (!reason) return answer(old, null)
    const expired = reason === "session-timeout" ? beginReflection(old, reason, now) : pauseSession(old, reason, now)
    const traced = appendTrace(expired.state, [{ channel: "terse", direction: "local", kind: "alarm.fired",
        from: "SeminarActor", to: "room", relayMessageId: null, eventId: null,
        summary: reason === "session-timeout" ? "Durable session deadline reached" : "Durable speaker lease expired",
        latencyMs: null, at: now }], now)
    return answer(traced.state, expired.result)
}

export function setReflection(old: RoomState, reflection: Reflection, now = Date.now()): Transition<void> {
    if (old.phase !== "reflection" && old.phase !== "ended") return answer(old, undefined)
    const s = clone(old); s.reflection = structuredClone(reflection); s.phase = "ended"; bump(s, now); refresh(s, now)
    return answer(s, undefined)
}

export function recordEvidenceRequest(old: RoomState, input: EvidenceRequestInput, now = Date.now()): Transition<{ ok: boolean; duplicate: boolean }> {
    if (old.evidence.some(e => e.id === input.requestId)) return answer(old, { ok: true, duplicate: true })
    if (old.phase !== "discussion") return answer(old, { ok: false, duplicate: false })
    const s = clone(old)
    const record: EvidenceRecord = { id: input.requestId, requestedBy: input.requestedBy, toolId: input.toolId, caseId: input.caseId, question: input.question, status: "pending", result: null, error: null, requestRelayMessageId: input.requestRelayMessageId, resultRelayMessageId: null, discussed: false, createdAt: now, completedAt: null }
    s.evidence = [...s.evidence, record]; s.updatedAt = now
    return answer(s, { ok: true, duplicate: false })
}

export function recordEvidenceResult(old: RoomState, input: EvidenceResultInput, now = Date.now()): Transition<EvidenceResultOutcome> {
    const previous = old.evidence.find(e => e.id === input.requestId)
    if (!previous) return answer(old, { ok: false, reason: "unknown-request" })
    if (previous.status !== "pending") return answer(old, { ok: false, reason: "duplicate" })
    const s = clone(old)
    const success = input.status === "returned" && input.result !== null
    const record: EvidenceRecord = { ...previous, status: success ? "returned" : "failed", result: success ? structuredClone(input.result) : null, error: success ? null : input.error ?? "Evidence tool returned no result", resultRelayMessageId: input.resultRelayMessageId, completedAt: now }
    s.evidence = s.evidence.map(e => e.id === input.requestId ? record : e)
    let cardId: string | null = null
    if (record.result) {
        const result = record.result
        const card = addCard(s, { kind: "evidence", text: result.observations[0] ?? result.title, authorId: "evidence", summarizedBy: null,
            supportingContributionIds: [], sourceIds: result.sourceStatements.map(item => item.sourceId), evidenceIds: [record.id], relations: [],
            status: result.kind === "source" ? "source-supported" : "tested-under-conditions", promptedBy: null, editedByHuman: false, createdAt: now, updatedAt: now })
        cardId = card.id
    }
    bump(s, now); refresh(s, now)
    return answer(s, { ok: true, record, cardId, version: s.version, floorIdle: s.floor === null })
}

export function editBoardCard(old: RoomState, input: BoardEditInput, now = Date.now()): Transition<BoardChangeResult> {
    const previous = old.board.find(c => c.id === input.cardId)
    if (!previous) return answer(old, { ok: false, reason: "unknown-card" })
    const s = clone(old)
    const card: BoardCard = { ...previous, text: input.text?.trim() || previous.text, editedByHuman: true, updatedAt: now,
        status: input.dismissed === true ? "dismissed" : input.dismissed === false && previous.status === "dismissed" ? "proposed" : input.text !== null ? "proposed" : previous.status }
    s.board = s.board.map(c => c.id === card.id ? card : c); bump(s, now); refresh(s, now)
    return answer(s, { ok: true, card })
}

export function addHumanCard(old: RoomState, input: HumanCardInput, now = Date.now()): Transition<BoardChangeResult> {
    if (!old.contributions.some(c => c.id === input.contributionId && c.status === "human" && c.speakerId === "human") || !input.text.trim()) return answer(old, { ok: false, reason: "invalid-reference" })
    const s = clone(old)
    const card = addCard(s, { kind: input.kind, text: input.text.trim(), authorId: "human", summarizedBy: null, supportingContributionIds: [input.contributionId], sourceIds: [], evidenceIds: [], relations: [], status: input.kind === "question" ? "unresolved" : "proposed", promptedBy: null, editedByHuman: true, createdAt: now, updatedAt: now })
    bump(s, now); refresh(s, now)
    return answer(s, { ok: true, card })
}

export function setContributionRelayMessageId(old: RoomState, contributionId: string, relayMessageId: string, now = Date.now()): Transition<void> {
    const s = clone(old); s.contributions = s.contributions.map(c => c.id === contributionId ? { ...c, relayMessageId } : c); s.updatedAt = now
    return answer(s, undefined)
}

export function markEventProcessed(old: RoomState, consumer: string, eventId: string, now = Date.now()): Transition<boolean> {
    if (old.processedEventKeys.includes(`${consumer}:${eventId}`)) return answer(old, false)
    const s = clone(old); dedupe(s, `${consumer}:${eventId}`); s.updatedAt = now
    return answer(s, true)
}

export function enqueueOutbound(old: RoomState, event: OutboundEvent, now = Date.now()): Transition<void> {
    if (old.pendingOutbound.some(e => e.eventId === event.eventId) || old.processedEventKeys.includes(`outbound:${event.eventId}`)) return answer(old, undefined)
    const s = clone(old); s.pendingOutbound = [...s.pendingOutbound, structuredClone(event)]; s.updatedAt = now
    return answer(s, undefined)
}

export function markOutboundSent(old: RoomState, eventId: string, now = Date.now()): Transition<void> {
    const s = clone(old); s.pendingOutbound = s.pendingOutbound.filter(e => e.eventId !== eventId); dedupe(s, `outbound:${eventId}`); s.updatedAt = now
    return answer(s, undefined)
}

export function appendTrace(old: RoomState, entries: TraceInput[], now = Date.now()): Transition<void> {
    const s = clone(old)
    s.trace = [...s.trace, ...entries.map(entry => ({ ...structuredClone(entry), id: `trace-${++s.counters.trace}`, at: entry.at ?? now }))].slice(-250)
    // Diagnostics do not alter conversational version or pause timestamps.
    return answer(s, undefined)
}

export function recoverAfterRestart(old: RoomState, now = Date.now()): Transition<RecoverResult> {
    if (old.phase === "ended") return answer(old, { recovered: false, interrupted: null, phase: old.phase, generationEpoch: old.generationEpoch })
    const s = clone(old); const interrupted = revoke(s, now)
    const recovered = old.phase === "discussion" || old.phase === "reflection" || old.floor !== null
    s.phase = "paused"; s.pauseReason = "restart"; s.generationEpoch++; s.version++; refresh(s, now)
    return answer(s, { recovered, interrupted, phase: s.phase, generationEpoch: s.generationEpoch })
}
