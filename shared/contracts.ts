// Typed application contracts shared by the backend, the agent workers and the browser.
//
// - RelayEnvelope: our schema carried in a Relaycast message's `data` field (read back as
//   `metadata`). These kinds are APPLICATION events, not provider event names.
// - ProposalDraft: what a reasoning worker (OpenAI or fixture) returns. Speaker and room identity
//   are bound by the server, never taken from model output.
// - ClientMessage / ServerMessage: the browser ⇄ backend WebSocket protocol.
// - REST request/response shapes.
//
// Room state shapes live in actor/src/roomTypes.ts (single source of truth).

import { z } from "zod"
import type {
    AddressedTo,
    BoardCardKind,
    BoardRelationType,
    Difficulty,
    EvidenceResult,
    Format,
    Participation,
    ParticipantId,
    PublicRoomState,
    SpeakerId,
    TopicCategory,
    TurnHint,
} from "../actor/src/roomTypes"

// ---------------------------------------------------------------------------------------------
// Primitive enums (zod mirrors of roomTypes unions; `satisfies` keeps them in sync)
// ---------------------------------------------------------------------------------------------

export const SpeakerIdSchema = z.enum(["facilitator", "maya", "theo"]) satisfies z.ZodType<SpeakerId>
export const ParticipantIdSchema = z.enum([
    "facilitator",
    "maya",
    "theo",
    "evidence",
    "human",
]) satisfies z.ZodType<ParticipantId>
export const AddressedToSchema = z.enum(["human", "maya", "theo", "group"]) satisfies z.ZodType<AddressedTo>
export const FormatSchema = z.enum(["socratic", "debate", "exploration"]) satisfies z.ZodType<Format>
export const TopicCategorySchema = z.enum([
    "software-engineering",
    "mathematics",
    "science",
    "history",
    "general-knowledge",
    "custom",
]) satisfies z.ZodType<TopicCategory>
export const DifficultySchema = z.enum(["introductory", "intermediate", "advanced"]) satisfies z.ZodType<Difficulty>
export const ParticipationSchema = z.enum(["participate", "observe", "lead"]) satisfies z.ZodType<Participation>
export const BoardCardKindSchema = z.enum(["claim", "question", "evidence", "revision"]) satisfies z.ZodType<BoardCardKind>
export const BoardRelationTypeSchema = z.enum([
    "supports",
    "challenges",
    "revises",
    "answers",
]) satisfies z.ZodType<BoardRelationType>

/** Relay identity names registered in the hackathon workspace. `bridge` is infrastructure, not an AI agent. */
export const RelayIdentitySchema = z.enum(["facilitator", "maya", "theo", "evidence", "bridge", "learner"])
export type RelayIdentity = z.infer<typeof RelayIdentitySchema>

// ---------------------------------------------------------------------------------------------
// Model output: ProposalDraft (validated after structured output; references re-checked by server)
// ---------------------------------------------------------------------------------------------

export const EvidenceRequestDraftSchema = z.object({
    toolId: z.string().min(1).max(64),
    caseId: z.string().max(64).nullable(),
    question: z.string().min(1).max(300),
})

export const BoardUpdateSchema = z.object({
    kind: z.enum(["claim", "question", "revision"]),
    text: z.string().min(1).max(220),
    relation: BoardRelationTypeSchema.nullable(),
    targetCardId: z.string().max(64).nullable(),
    attributeToHumanContributionId: z.string().max(64).nullable(),
})

export const ProposalDraftSchema = z.object({
    action: z.enum(["contribute", "request_evidence", "yield"]),
    replyToContributionId: z.string().max(64).nullable(),
    addressedTo: AddressedToSchema,
    /** One or two sentences, usually under 45 words. Empty only when action is "yield". */
    text: z.string().max(600),
    sourceIds: z.array(z.string().max(64)).max(4),
    evidenceRequest: EvidenceRequestDraftSchema.nullable(),
    boardUpdate: BoardUpdateSchema.nullable(),
    /** The agent's private, updated working belief. Kept in worker memory, never spoken or shared. */
    privateNote: z.string().max(400),
})
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>

export const ReflectionDraftSchema = z.object({
    initialPosition: z.object({ text: z.string().max(300), contributionIds: z.array(z.string()).max(3) }).nullable(),
    challenge: z.object({ text: z.string().max(300), contributionIds: z.array(z.string()).max(3) }).nullable(),
    revisedPosition: z.object({ text: z.string().max(300), contributionIds: z.array(z.string()).max(3) }).nullable(),
    usefulQuestion: z.object({ text: z.string().max(300), contributionIds: z.array(z.string()).max(3) }).nullable(),
    revisedAssumption: z.object({ text: z.string().max(300), contributionIds: z.array(z.string()).max(3) }).nullable(),
    unresolved: z.object({ text: z.string().max(300), cardIds: z.array(z.string()).max(3) }).nullable(),
    nextQuestion: z.string().min(1).max(300),
    contributionImpact: z.object({ text: z.string().max(300), contributionIds: z.array(z.string()).max(3) }).nullable(),
})
export type ReflectionDraft = z.infer<typeof ReflectionDraftSchema>

// ---------------------------------------------------------------------------------------------
// Relay envelope (carried in message `data`; Relaycast returns it as `metadata`)
// ---------------------------------------------------------------------------------------------

export const TurnHintSchema = z.object({
    mode: z.enum([
        "open",
        "peer-exchange",
        "invite-human",
        "await-human",
        "respond-to-human",
        "respond-to-evidence",
        "wrap-up",
        "closed",
    ]),
    preferredSpeakers: z.array(SpeakerIdSchema),
    requiredAddressee: AddressedToSchema.nullable(),
    debateStage: z.enum(["opening", "cross-examination", "rebuttal", "closing"]).nullable(),
    reason: z.string(),
}) satisfies z.ZodType<TurnHint>

const EnvelopeBase = z.object({
    v: z.literal(1),
    eventId: z.string().min(1).max(128),
    roomId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    /** Sender identity as asserted by the application (Relay also authenticates the token's agent). */
    actorId: RelayIdentitySchema,
    /** Contribution id this event replies to, if any. */
    replyTo: z.string().max(64).nullable(),
    roomVersion: z.number().int().nonnegative(),
    generationEpoch: z.number().int().nonnegative(),
    utteranceId: z.string().max(128).nullable(),
    text: z.string().max(4000),
})

const ContributionPayload = z.object({
    contributionId: z.string(),
    speakerId: ParticipantIdSchema,
    addressedTo: AddressedToSchema,
    replyToContributionId: z.string().nullable(),
    /** Only the delivered prefix. Unheard generated text is never published. */
    heardText: z.string(),
    interrupted: z.boolean(),
    sourceIds: z.array(z.string()),
})

const EvidenceResultSchema: z.ZodType<EvidenceResult> = z.object({
    kind: z.enum(["experiment", "source", "calculation", "dataset"]),
    title: z.string(),
    assumptions: z.array(z.string()),
    observations: z.array(z.string()),
    sourceStatements: z.array(z.object({ sourceId: z.string(), statement: z.string() })),
    limitations: z.array(z.string()),
    unresolved: z.array(z.string()),
    metrics: z.record(z.string(), z.number()),
    events: z.array(z.object({ t: z.number(), actor: z.string(), label: z.string(), detail: z.string() })),
})

export const ProposalWireSchema = z.object({
    proposalId: z.string().min(1).max(128),
    speakerId: SpeakerIdSchema,
    basedOnRoomVersion: z.number().int().nonnegative(),
    generationEpoch: z.number().int().nonnegative(),
    replyToContributionId: z.string().max(64).nullable(),
    addressedTo: AddressedToSchema,
    action: z.enum(["contribute", "request_evidence", "yield"]),
    text: z.string().max(600),
    sourceIds: z.array(z.string().max(64)).max(4),
    evidenceRequest: EvidenceRequestDraftSchema.nullable(),
    boardUpdate: BoardUpdateSchema.nullable(),
    reasoning: z.enum(["openai", "fixture", "external"]),
    /** Model call latency, for the trace panel. */
    latencyMs: z.number().nonnegative().nullable(),
})
export type ProposalWire = z.infer<typeof ProposalWireSchema>

export const RelayEnvelopeSchema = z.discriminatedUnion("kind", [
    /** bridge → channel: a new session started (workers reset per-room memory). */
    EnvelopeBase.extend({
        kind: z.literal("session.started"),
        payload: z.object({
            topicId: z.string(),
            topicTitle: z.string(),
            format: FormatSchema,
            participation: ParticipationSchema,
            difficulty: DifficultySchema,
            openingQuestion: z.string(),
            hint: TurnHintSchema,
        }),
    }),
    /** speaking agent → channel: what the room actually heard (complete or interrupted prefix). */
    EnvelopeBase.extend({
        kind: z.literal("contribution.heard"),
        payload: ContributionPayload.extend({ hint: TurnHintSchema }),
    }),
    /** learner identity → channel: a completed human turn (voice or text). */
    EnvelopeBase.extend({
        kind: z.literal("human.contributed"),
        payload: ContributionPayload.extend({
            inputMode: z.enum(["voice", "text"]),
            correctionOf: z.string().nullable(),
            hint: TurnHintSchema,
        }),
    }),
    /** bridge → channel: the floor is open (kickoff, await timeout, "keep going", evidence back, resume). */
    EnvelopeBase.extend({
        kind: z.literal("floor.opened"),
        payload: z.object({ reason: z.string(), hint: TurnHintSchema }),
    }),
    /** bridge → channel: lease revoked / epoch advanced; workers abort older-epoch work. */
    EnvelopeBase.extend({
        kind: z.literal("floor.revoked"),
        payload: z.object({ reason: z.string(), newEpoch: z.number().int().nonnegative() }),
    }),
    /** worker → bridge (DM): a structured proposal for the next turn (or a yield). */
    EnvelopeBase.extend({
        kind: z.literal("floor.requested"),
        payload: z.object({ proposal: ProposalWireSchema }),
    }),
    /** worker/learner → evidence (DM): run a tool or look up a source. */
    EnvelopeBase.extend({
        kind: z.literal("evidence.requested"),
        payload: z.object({
            requestId: z.string(),
            requestedBy: ParticipantIdSchema,
            toolId: z.string(),
            caseId: z.string().nullable(),
            question: z.string(),
        }),
    }),
    /** evidence → channel: result (or failure) with assumptions, observations and limitations. */
    EnvelopeBase.extend({
        kind: z.literal("evidence.returned"),
        payload: z.object({
            requestId: z.string(),
            requestedBy: ParticipantIdSchema,
            toolId: z.string(),
            caseId: z.string().nullable(),
            status: z.enum(["returned", "failed"]),
            result: EvidenceResultSchema.nullable(),
            error: z.string().nullable(),
        }),
    }),
    /** bridge → channel: lifecycle. */
    EnvelopeBase.extend({
        kind: z.literal("session.paused"),
        payload: z.object({ reason: z.string() }),
    }),
    EnvelopeBase.extend({
        kind: z.literal("session.resumed"),
        payload: z.object({ hint: TurnHintSchema }),
    }),
    EnvelopeBase.extend({
        kind: z.literal("session.ended"),
        payload: z.object({ reason: z.string() }),
    }),
])
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>
export type RelayEventKind = RelayEnvelope["kind"]
export type EnvelopeOf<K extends RelayEventKind> = Extract<RelayEnvelope, { kind: K }>

// ---------------------------------------------------------------------------------------------
// Provider status (shown in the UI; never contains secret values)
// ---------------------------------------------------------------------------------------------

export type ProviderMode = "live" | "fixture" | "unavailable"

export interface ProviderState {
    mode: ProviderMode
    /** Human-readable label, e.g. "OpenAI gpt-… (live)" or "Fixture lines — OpenAI key missing". */
    label: string
    /** Names of missing variables (never values). */
    missing: string[]
    /** Last error message (redacted), if any. */
    lastError: string | null
}

export interface ProviderStatus {
    appMode: "live" | "fixture"
    reasoning: ProviderState
    voice: ProviderState
    transcription: ProviderState
    relay: ProviderState & { workspaceId: string | null; deliveryMode: "polling" | "websocket" | "memory"; measuredDeliveryP50Ms: number | null; deliveryState?: string; deliveryReason?: string | null }
    terse: ProviderState & { actorUrl: string }
}

// ---------------------------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------------------------

export const CreateRoomRequestSchema = z.object({
    topicId: z.string().min(1).max(64),
    category: TopicCategorySchema,
    format: FormatSchema,
    difficulty: DifficultySchema,
    participation: ParticipationSchema,
    customQuestion: z.string().trim().max(400).nullable(),
    reading: z.string().max(6000).nullable(),
    theme: z.enum(["halloween", "classroom"]).optional(),
})
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>

export interface CreateRoomResponse {
    roomId: string
    sessionId: string
    /** Random per-room secret required by room-scoped endpoints (grant, STT token, TTS, WS). */
    roomToken: string
}

export interface TerseGrantResponse {
    websocketUrl: string
    connectByMs: number
}

export interface SttTokenResponse {
    token: string
    modelId: string
}

// ---------------------------------------------------------------------------------------------
// Browser ⇄ backend WebSocket protocol (/ws?roomId=…&roomToken=…)
// ---------------------------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("hello"), clientId: z.string().max(64), resume: z.boolean() }),
    z.object({
        type: z.literal("playback.segment"),
        utteranceId: z.string(),
        segmentIndex: z.number().int().nonnegative(),
        event: z.enum(["started", "ended"]),
    }),
    z.object({
        type: z.literal("playback.finished"),
        utteranceId: z.string(),
        outcome: z.enum(["completed", "interrupted", "failed"]),
        error: z.string().max(300).nullable(),
    }),
    /** Stop audio (already stopped locally), revoke the lease and give the human the floor. */
    z.object({ type: z.literal("human.jumpIn"), source: z.enum(["button", "voice-onset"]) }),
    z.object({
        type: z.literal("human.contribution"),
        eventId: z.string().min(1).max(128),
        text: z.string().trim().min(1).max(2000),
        inputMode: z.enum(["voice", "text"]),
        replyToContributionId: z.string().max(64).nullable(),
        addressedTo: AddressedToSchema,
    }),
    z.object({
        type: z.literal("human.correction"),
        eventId: z.string().min(1).max(128),
        contributionId: z.string().max(64),
        text: z.string().trim().min(1).max(2000),
    }),
    /** "Keep going": decline the offered floor and let the peers continue. */
    z.object({ type: z.literal("human.pass") }),
    z.object({ type: z.literal("session.pause") }),
    z.object({ type: z.literal("session.resume") }),
    z.object({ type: z.literal("session.end") }),
    z.object({ type: z.literal("session.theme"), theme: z.enum(["halloween", "classroom"]) }),
    z.object({ type: z.literal("evidence.request"), toolId: z.string().max(64), caseId: z.string().max(64).nullable() }),
    z.object({
        type: z.literal("board.edit"),
        cardId: z.string().max(64),
        text: z.string().trim().max(220).nullable(),
        dismissed: z.boolean().nullable(),
    }),
    z.object({
        type: z.literal("board.addHumanCard"),
        contributionId: z.string().max(64),
        kind: z.enum(["claim", "question", "revision"]),
        text: z.string().trim().min(1).max(220),
    }),
    z.object({ type: z.literal("client.visibility"), hidden: z.boolean() }),
    z.object({
        type: z.literal("metric"),
        name: z.enum(["human-turn-to-first-audio", "interrupt-to-silence", "segment-first-byte"]),
        ms: z.number().nonnegative(),
    }),
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export type VoicePlan =
    /** Each segment is fetched from /api/tts/:roomId/:utteranceId/:segmentIndex?epoch=…&roomToken=… */
    | { mode: "elevenlabs"; segmentUrls: string[] }
    /** Clearly-labelled fixture: browser speechSynthesis with a per-speaker voice hint. */
    | { mode: "browser"; voiceHint: { speakerId: SpeakerId; pitch: number; rate: number } }

export type ServerMessage =
    | { type: "snapshot"; state: PublicRoomState }
    | { type: "welcome"; roomId: string; sessionId: string; providers: ProviderStatus }
    | {
          type: "speak"
          utteranceId: string
          contributionId: string
          speakerId: SpeakerId
          generationEpoch: number
          segments: string[]
          voice: VoicePlan
      }
    /** Stop any playback whose epoch is older than `generationEpoch`. */
    | { type: "stop"; generationEpoch: number; reason: string }
    | { type: "providers"; providers: ProviderStatus }
    | { type: "metric"; name: string; ms: number; at: number }
    | { type: "notice"; level: "info" | "warning" | "error"; text: string }
    | { type: "thinking"; speakerIds: SpeakerId[] }

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Split text into sentence-sized playback segments (conservative heard-prefix tracking). */
export function splitIntoSegments(text: string): string[] {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (normalized.length === 0) return []
    // Sentence segmentation preserves decimal numbers, abbreviations and punctuation.
    const parts = Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(normalized), part => part.segment)
    const segments = parts.map((part) => part.trim()).filter((part) => part.length > 0)
    // Merge very short fragments (e.g. "Hm.") into the following segment.
    const merged: string[] = []
    for (const segment of segments) {
        const last = merged[merged.length - 1]
        if (last !== undefined && last.split(" ").length < 3) merged[merged.length - 1] = `${last} ${segment}`
        else merged.push(segment)
    }
    return merged
}

export const SPEAKER_NAMES: Record<ParticipantId, string> = {
    facilitator: "Jack Skellington",
    maya: "Count Dracula",
    theo: "Wednesday Addams",
    evidence: "Evidence",
    human: "You",
}

export const CLASSROOM_SPEAKER_NAMES: Record<ParticipantId, string> = {
    facilitator: "Facilitator",
    maya: "Maya",
    theo: "Theo",
    evidence: "Evidence",
    human: "You",
}

export function speakerNames(theme?: "halloween" | "classroom"): Record<ParticipantId, string> {
    return theme === "halloween" ? SPEAKER_NAMES : CLASSROOM_SPEAKER_NAMES
}
