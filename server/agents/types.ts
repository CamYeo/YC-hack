// Reasoning contract for the four logical AI agents (facilitator, Maya, Theo, evidence).
// Separate identities, prompts, private memory and Relay handling; may share one model/process.

import type { BoardCard, Contribution, EvidenceRecord, RoomConfig, SpeakerId, TurnHint } from "../../actor/src/roomTypes"
import type { ProposalDraft, RelayEnvelope, ReflectionDraft } from "../../shared/contracts"
import type { TopicPack } from "../../shared/topic"

/** What a speaking agent sees. Built from the actor snapshot + the Relay trigger. Heard text only. */
export interface AgentContext {
    agentId: SpeakerId
    roomId: string
    sessionId: string
    config: RoomConfig
    topic: TopicPack
    /** Recent contributions with ONLY heard text (status heard/interrupted/human), oldest first. */
    transcript: Pick<Contribution, "id" | "speakerId" | "addressedTo" | "replyToContributionId" | "heardText" | "status" | "sourceIds">[]
    board: Pick<BoardCard, "id" | "kind" | "text" | "authorId" | "status" | "relations">[]
    evidence: Pick<EvidenceRecord, "id" | "requestedBy" | "toolId" | "caseId" | "status" | "result" | "error">[]
    hint: TurnHint
    /** The Relay event that triggered this reasoning call. */
    trigger: RelayEnvelope
    /** This agent's own private working notes from earlier turns (never shared). */
    privateNotes: string[]
    roomVersion: number
    generationEpoch: number
}

export interface Reasoner {
    readonly mode: "openai" | "fixture" | "external"
    /** Human-readable label for the status panel, e.g. "OpenAI gpt-… (live)". */
    readonly label: string
    propose(context: AgentContext, signal: AbortSignal): Promise<{ draft: ProposalDraft; latencyMs: number; cacheHit?: boolean }>
    reflect(input: ReflectionInput, signal: AbortSignal): Promise<{ draft: ReflectionDraft; latencyMs: number }>
}

export interface ReflectionInput {
    config: RoomConfig
    topic: TopicPack
    transcript: Pick<Contribution, "id" | "speakerId" | "heardText" | "status" | "replyToContributionId">[]
    board: Pick<BoardCard, "id" | "kind" | "text" | "authorId" | "status" | "promptedBy" | "supportingContributionIds">[]
    evidence: Pick<EvidenceRecord, "id" | "toolId" | "caseId" | "status" | "result">[]
}

export class ReasonerError extends Error {
    readonly retryable: boolean
    constructor(message: string, retryable: boolean) {
        super(message)
        this.name = "ReasonerError"
        this.retryable = retryable
    }
}

// ---------------------------------------------------------------------------------------------
// Worker factories (implemented in ./speakingWorker.ts and ./evidenceWorker.ts)
// ---------------------------------------------------------------------------------------------

export interface PublishHeardInput {
    roomId: string
    sessionId: string
    contribution: Contribution
    hint: TurnHint
    roomVersion: number
    generationEpoch: number
    channel: string
}

export interface SendEvidenceRequestInput {
    roomId: string
    sessionId: string
    requestId: string
    toolId: string
    caseId: string | null
    question: string
    replyToContributionId: string | null
    roomVersion: number
    generationEpoch: number
}

export interface SpeakingWorker {
    readonly id: SpeakerId
    start(): void
    stop(): Promise<void>
    /** Post `contribution.heard` from THIS agent's Relay identity (via the outbox). Returns the Relay message id. */
    publishHeard(input: PublishHeardInput): Promise<string>
    /** DM `evidence.requested` from THIS agent's identity after its request_evidence proposal won the floor. */
    requestEvidence(input: SendEvidenceRequestInput): Promise<string>
}

export interface EvidenceWorker {
    start(): void
    stop(): Promise<void>
}

export interface TopicRegistry {
    get(topicId: string): TopicPack | null
    list(): TopicPack[]
    /** Builds the custom pack from the user's question and optional reading (no bundled sources). */
    custom(question: string, reading: string | null): TopicPack
}

export interface ToolRunner {
    /** Deterministic; returns status "failed" with an error for unknown tools/cases (never throws for bad input). */
    run(input: { topic: TopicPack; toolId: string; caseId: string | null; question: string }): EvidenceRunResult
}

export type EvidenceRunResult =
    | { status: "returned"; result: import("../../actor/src/roomTypes").EvidenceResult }
    | { status: "failed"; error: string }

/** Everything a worker needs. Workers create their own DeliveryPump (added to `pumps`) in start(). */
export interface WorkerDeps {
    relay: import("../providers/relay/types").RelayTransport
    store: import("../seminar/roomStore").RoomStore
    outbox: import("../seminar/outbox.types").Outbox
    pumps: import("../providers/relay/types").DeliveryPumpGroup
    reasoner: Reasoner
    topics: TopicRegistry
    tools: ToolRunner
    logger: import("../log").Logger
    clock: () => number
}
