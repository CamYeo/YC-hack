// Authoritative room-state model for the SeminarActor.
//
// This file is the single source of truth for room state shapes. It is plain TypeScript with no
// imports so that the actor (compiled by the Terse runtime), the Bun backend, the tests and the
// browser can all import it (the latter two with `import type`).
//
// Pure transitions live in ./roomLogic.ts. The actor class in ./actors.ts only stores fields and
// delegates to roomLogic, so tests can exercise the exact same logic without the runtime.

// ---------------------------------------------------------------------------------------------
// Identities and settings
// ---------------------------------------------------------------------------------------------

/** The three audible AI participants. */
export type SpeakerId = "facilitator" | "maya" | "theo"

/** Everyone who can author a contribution, a board card or an evidence request. */
export type ParticipantId = SpeakerId | "evidence" | "human"

/** Who a contribution is addressed to (matches the build spec's Proposal contract). */
export type AddressedTo = "human" | "maya" | "theo" | "group"

export type Format = "socratic" | "debate" | "exploration"
export type TopicCategory =
    | "software-engineering"
    | "mathematics"
    | "science"
    | "history"
    | "general-knowledge"
    | "custom"
export type Difficulty = "introductory" | "intermediate" | "advanced"
export type Participation = "participate" | "observe" | "lead"
export type RoomTheme = "halloween" | "classroom"

/** discussion → paused ⇄ discussion → reflection → ended. A topic change creates a new room. */
export type Phase = "discussion" | "paused" | "reflection" | "ended"

export type DebateStage = "opening" | "cross-examination" | "rebuttal" | "closing"

export interface RoomConfig {
    topicId: string
    topicTitle: string
    category: TopicCategory
    format: Format
    /** Old rooms with no theme use the classroom presentation. */
    theme?: RoomTheme
    difficulty: Difficulty
    participation: Participation
    /** The question the facilitator opens with (topic pack question or the user's custom question). */
    openingQuestion: string
    /** User-supplied question for custom topics, otherwise null. */
    customQuestion: string | null
    /** User-pasted reading. Treated as data, never as instructions. */
    reading: string | null
    sessionMinutes: number
    /** Hard cap on AI utterances in this session. */
    maxAiTurns: number
    /** Hard cap on reasoning calls (proposals received) in this session. */
    maxGenerationCalls: number
    /** Peer (Maya/Theo) turns since the last human contribution before the floor is offered. */
    aiTurnsBeforeInvite: number
    /** Relaycast channel carrying this room's public discussion. */
    relayChannel: string
}

// ---------------------------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------------------------

/**
 * speaking    — floor granted, audio may be playing; NOT shared knowledge yet.
 * heard       — every segment was acknowledged by the browser.
 * interrupted — only `heardText` (the acknowledged prefix) entered shared context.
 * human       — a completed human turn.
 * superseded  — a human turn replaced by a correction.
 */
export type ContributionStatus = "speaking" | "heard" | "interrupted" | "human" | "superseded"

export interface Contribution {
    id: string
    speakerId: ParticipantId
    replyToContributionId: string | null
    addressedTo: AddressedTo
    /** What the model produced (AI) or the final transcript (human). Never shared before it is heard. */
    generatedText: string
    /** Conservative delivered prefix: the acknowledged segments joined with spaces. */
    heardText: string
    /** Sentence-sized playback segments (AI) or [text] (human). */
    segments: string[]
    segmentsHeard: number
    status: ContributionStatus
    sourceIds: string[]
    utteranceId: string | null
    proposalId: string | null
    generationEpoch: number
    inputMode: "ai" | "voice" | "text"
    /** For human corrections: the contribution id this one replaces. */
    correctionOf: string | null
    /** Relay message id of the public contribution.heard / human.contributed post. */
    relayMessageId: string | null
    eventId: string
    createdAt: number
    completedAt: number | null
}

// ---------------------------------------------------------------------------------------------
// Reasoning board
// ---------------------------------------------------------------------------------------------

export type BoardCardKind = "claim" | "question" | "evidence" | "revision"

/** Agreement alone never upgrades a status. */
export type BoardCardStatus =
    | "proposed"
    | "source-supported"
    | "tested-under-conditions"
    | "contested"
    | "unresolved"
    | "stale"
    | "dismissed"

export type BoardRelationType = "supports" | "challenges" | "revises" | "answers"

export interface BoardRelation {
    type: BoardRelationType
    targetCardId: string
}

export interface BoardCard {
    id: string
    kind: BoardCardKind
    text: string
    /** Who made the claim. A human claim is only ever attributed via a human contribution id. */
    authorId: ParticipantId
    /** Set when an AI summarised a human contribution into this card (the human can edit/dismiss). */
    summarizedBy: ParticipantId | null
    supportingContributionIds: string[]
    sourceIds: string[]
    evidenceIds: string[]
    relations: BoardRelation[]
    status: BoardCardStatus
    /** For revisions/challenges: the participant + contribution that prompted the change. */
    promptedBy: { participantId: ParticipantId; contributionId: string } | null
    editedByHuman: boolean
    createdAt: number
    updatedAt: number
}

/** A board change proposed alongside an utterance. Applied only once the utterance is fully heard. */
export interface BoardUpdate {
    kind: BoardCardKind
    text: string
    relation: BoardRelationType | null
    targetCardId: string | null
    /** If set, the card is the human's claim (author "human"), summarised by the proposing AI. */
    attributeToHumanContributionId: string | null
}

// ---------------------------------------------------------------------------------------------
// Floor control and proposals
// ---------------------------------------------------------------------------------------------

export interface FloorLease {
    speakerId: SpeakerId
    utteranceId: string
    contributionId: string
    proposalId: string
    generationEpoch: number
    grantedAt: number
    /** Renewed by each acknowledged segment; a crashed speaker cannot hold the floor forever. */
    expiresAt: number
}

export type ProposalAction = "contribute" | "request_evidence" | "yield"

export interface EvidenceRequestDraft {
    toolId: string
    caseId: string | null
    question: string
}

export interface PendingProposal {
    proposalId: string
    /** Relay event id of the floor.requested message that carried it. */
    eventId: string
    speakerId: SpeakerId
    basedOnRoomVersion: number
    generationEpoch: number
    replyToContributionId: string | null
    addressedTo: AddressedTo
    action: ProposalAction
    text: string
    sourceIds: string[]
    evidenceRequest: EvidenceRequestDraft | null
    boardUpdate: BoardUpdate | null
    relayMessageId: string | null
    reasoning: "openai" | "fixture" | "external"
    receivedAt: number
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

export interface EvidenceEvent {
    /** Simulated milliseconds since the start of the experiment (not wall-clock). */
    t: number
    actor: string
    label: string
    detail: string
}

export interface EvidenceResult {
    kind: "experiment" | "source" | "calculation" | "dataset"
    title: string
    assumptions: string[]
    observations: string[]
    sourceStatements: { sourceId: string; statement: string }[]
    limitations: string[]
    unresolved: string[]
    metrics: Record<string, number>
    events: EvidenceEvent[]
}

export interface EvidenceRecord {
    id: string
    requestedBy: ParticipantId
    toolId: string
    caseId: string | null
    question: string
    status: "pending" | "returned" | "failed"
    result: EvidenceResult | null
    error: string | null
    /** Relay message id of the evidence.requested DM. */
    requestRelayMessageId: string | null
    /** Relay message id of the evidence.returned channel post. */
    resultRelayMessageId: string | null
    /** True once an AI turn has been heard after the result arrived. */
    discussed: boolean
    createdAt: number
    completedAt: number | null
}

// ---------------------------------------------------------------------------------------------
// Turn-taking
// ---------------------------------------------------------------------------------------------

export type TurnMode =
    | "open" // session opening: facilitator frames the question
    | "peer-exchange" // Maya and Theo talk to each other
    | "invite-human" // the next AI turn must address the human directly
    | "await-human" // the floor is with the human; AI stays quiet
    | "respond-to-human" // a peer (or facilitator) responds to the human's turn
    | "respond-to-evidence" // discuss a freshly returned evidence result
    | "wrap-up" // facilitator summarises before the session ends
    | "closed" // paused / reflection / ended — nobody proposes

/** Deterministic hint computed by roomLogic after each committed turn and carried in Relay envelopes. */
export interface TurnHint {
    mode: TurnMode
    /** Speakers invited to propose, in preference order. Addressed peers may always propose. */
    preferredSpeakers: SpeakerId[]
    /** If set, the selected proposal must address this target (e.g. "human" for invite-human). */
    requiredAddressee: AddressedTo | null
    debateStage: DebateStage | null
    reason: string
}

export interface TurnState {
    /** Maya/Theo turns since the last human contribution (facilitator turns do not count). */
    peerStreak: number
    awaitingHuman: boolean
    invitedAt: number | null
    lastSpeakerId: ParticipantId | null
    speakerCounts: Record<SpeakerId, number>
    debateStage: DebateStage | null
    /** AI turns heard in the current debate stage. */
    stageTurns: number
    hint: TurnHint
}

export interface Budget {
    startedAt: number
    endsAt: number
    aiTurnsUsed: number
    maxAiTurns: number
    generationCalls: number
    maxGenerationCalls: number
}

// ---------------------------------------------------------------------------------------------
// Reflection
// ---------------------------------------------------------------------------------------------

export interface CitedText {
    text: string
    contributionIds: string[]
}

export interface Reflection {
    generatedBy: "openai" | "fixture"
    /** The learner's own words where available. */
    initialPosition: CitedText | null
    challenge: CitedText | null
    revisedPosition: CitedText | null
    usefulQuestion: CitedText | null
    revisedAssumption: CitedText | null
    unresolved: { text: string; cardIds: string[] } | null
    /** One concrete question or scenario to try next. */
    nextQuestion: string
    /** Only when supported by the transcript: how a human contribution changed the discussion. */
    contributionImpact: CitedText | null
    createdAt: number
}

// ---------------------------------------------------------------------------------------------
// Behind-the-discussion trace and outbox
// ---------------------------------------------------------------------------------------------

export interface TraceEntry {
    id: string
    at: number
    channel: "relay" | "terse" | "openai" | "elevenlabs" | "system"
    direction: "out" | "in" | "local"
    kind: string
    from: string
    to: string
    relayMessageId: string | null
    eventId: string | null
    summary: string
    latencyMs: number | null
}

export type OutboundTarget = { type: "channel"; channel: string } | { type: "dm"; to: string }

/** A Relay post recorded before sending, so a crash between commit and send can be retried idempotently. */
export interface OutboundEvent {
    eventId: string
    /** Relay identity name that must send it (facilitator, maya, theo, evidence, bridge, learner). */
    sender: string
    target: OutboundTarget
    text: string
    /** JSON-encoded RelayEnvelope (kept as a string so the actor contract stays simple). */
    envelopeJson: string
    createdAt: number
    attempts: number
}

// ---------------------------------------------------------------------------------------------
// Full state (what roomLogic transforms) and the public snapshot
// ---------------------------------------------------------------------------------------------

export interface RoomState {
    roomId: string
    sessionId: string
    config: RoomConfig | null
    phase: Phase
    pauseReason: string | null
    /** Bumped whenever shared conversational context changes. Proposals must match it exactly. */
    version: number
    /** Bumped on every interruption/pause/reset. Work from an older epoch is discarded. */
    generationEpoch: number
    contributions: Contribution[]
    board: BoardCard[]
    floor: FloorLease | null
    pendingProposals: PendingProposal[]
    evidence: EvidenceRecord[]
    turn: TurnState
    budget: Budget
    reflection: Reflection | null
    trace: TraceEntry[]
    /** `${consumer}:${eventId}` keys, newest last, bounded. Not emitted to browsers. */
    processedEventKeys: string[]
    /** Not emitted to browsers. */
    pendingOutbound: OutboundEvent[]
    /** Monotonic counters for stable ids (c-1, card-1, ...). */
    counters: { contribution: number; card: number; trace: number }
    createdAt: number
    updatedAt: number
}

/** Fields the actor emits to connected browsers (everything except dedupe keys and the outbox). */
export type PublicRoomState = Omit<RoomState, "processedEventKeys" | "pendingOutbound">

// ---------------------------------------------------------------------------------------------
// Actor method inputs / results (the actor methods and RoomStore share these exact shapes)
// ---------------------------------------------------------------------------------------------

export interface StartSessionInput {
    roomId: string
    sessionId: string
    config: RoomConfig
}

export interface HumanContributionInput {
    eventId: string
    text: string
    inputMode: "voice" | "text"
    replyToContributionId: string | null
    addressedTo: AddressedTo
    /** Correction of an earlier human contribution (creates a new version; dependent cards go stale). */
    correctionOf: string | null
}

export type HumanContributionResult =
    | { ok: true; contribution: Contribution; hint: TurnHint; version: number; interrupted: Contribution | null }
    | { ok: false; reason: "duplicate" | "not-accepting" | "invalid-correction" | "empty" }

export interface ProposalInput {
    proposalId: string
    eventId: string
    sessionId: string
    speakerId: SpeakerId
    basedOnRoomVersion: number
    generationEpoch: number
    replyToContributionId: string | null
    addressedTo: AddressedTo
    action: ProposalAction
    text: string
    sourceIds: string[]
    evidenceRequest: EvidenceRequestDraft | null
    boardUpdate: BoardUpdate | null
    relayMessageId: string | null
    reasoning: "openai" | "fixture" | "external"
}

export type SubmitProposalResult =
    | { ok: true; pendingCount: number }
    | {
          ok: false
          reason:
              | "duplicate"
              | "wrong-session"
              | "stale-version"
              | "stale-epoch"
              | "not-accepting"
              | "invalid-reference"
              | "budget-exhausted"
      }

export interface ClaimFloorInput {
    proposalId: string
    utteranceId: string
    /** Sentence-sized segments of the proposal text, in playback order. */
    segments: string[]
    leaseMs: number
}

export type ClaimFloorResult =
    | { ok: true; lease: FloorLease; contribution: Contribution }
    | {
          ok: false
          reason:
              | "floor-busy"
              | "unknown-proposal"
              | "stale-version"
              | "stale-epoch"
              | "not-in-discussion"
              | "awaiting-human"
              | "budget-exhausted"
              | "time-up"
              | "addressee-required"
      }

export interface SegmentHeardInput {
    utteranceId: string
    segmentIndex: number
    leaseMs: number
}

export type SegmentHeardResult =
    | { ok: true; segmentsHeard: number; heardText: string }
    | { ok: false; reason: "unknown-utterance" | "not-speaking" | "out-of-order" }

export interface FinishUtteranceInput {
    utteranceId: string
    outcome: "completed" | "interrupted" | "failed"
}

export type FinishUtteranceResult =
    | { ok: true; contribution: Contribution; hint: TurnHint; version: number; boardCardIds: string[] }
    | { ok: false; reason: "unknown-utterance" | "already-finished" }

export type InterruptReason =
    | "human-jump-in"
    | "voice-onset"
    | "correction"
    | "relay-failure"
    | "provider-failure"

export interface InterruptResult {
    generationEpoch: number
    version: number
    interrupted: Contribution | null
}

export type OpenFloorReason = "kickoff" | "await-timeout" | "human-pass" | "evidence-returned" | "resume"

export interface OpenFloorResult {
    ok: boolean
    hint: TurnHint
    version: number
}

export interface EvidenceRequestInput {
    requestId: string
    requestedBy: ParticipantId
    toolId: string
    caseId: string | null
    question: string
    requestRelayMessageId: string | null
}

export interface EvidenceResultInput {
    requestId: string
    status: "returned" | "failed"
    result: EvidenceResult | null
    error: string | null
    resultRelayMessageId: string | null
}

export type EvidenceResultOutcome =
    | { ok: true; record: EvidenceRecord; cardId: string | null; version: number; floorIdle: boolean }
    | { ok: false; reason: "unknown-request" | "duplicate" }

export interface BoardEditInput {
    cardId: string
    text: string | null
    dismissed: boolean | null
}

export interface HumanCardInput {
    contributionId: string
    kind: BoardCardKind
    text: string
}

export type BoardChangeResult = { ok: true; card: BoardCard } | { ok: false; reason: "unknown-card" | "invalid-reference" }

export interface RecoverResult {
    /** True if a lease was revoked or the phase was forced to paused. */
    recovered: boolean
    interrupted: Contribution | null
    phase: Phase
    generationEpoch: number
}

export type TraceInput = Omit<TraceEntry, "id" | "at"> & { at?: number }
