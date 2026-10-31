// Relaycast transport contract. Implementations:
//   ./liveRelay.ts   — real Relaycast REST API (https://armadillo.agentrelay.com/v1), verified by spike:
//                      POST /channels/{name}/messages with `data` → readable back as `metadata`;
//                      per-recipient deliveries (sender excluded) via GET /deliveries + POST /deliveries/{id}/ack;
//                      Idempotency-Key replays return the same message id; DMs via POST /dm {to,text,data}.
//                      Delivery records include message text but NOT metadata → fetch GET /messages/{id}.
//   ./memoryRelay.ts — in-process fake with identical semantics (tests + labelled fixture mode only).

import type { RelayIdentity } from "../../../shared/contracts"

export interface RelayPostResult {
    messageId: string
    /** True when the Idempotency-Key matched an earlier post (same message id returned). */
    replayed: boolean
    latencyMs: number
}

export interface RelayInboundMessage {
    deliveryId: string
    messageId: string
    /** Channel name for channel posts; null for DMs. */
    channel: string | null
    isDm: boolean
    senderName: string
    text: string
    /** The `data` object we attached when posting (Relaycast returns it as `metadata`). Unvalidated. */
    metadata: Record<string, unknown> | null
    createdAt: string
    /** Wall-clock ms between message creation and our receipt (measured, for honest labelling). */
    deliveryDelayMs: number | null
}

export interface RelayDeliveryStatus {
    mode: "websocket" | "polling" | "memory"
    state: "connecting" | "connected" | "reconnecting" | "unavailable" | "stopped"
    /** Safe explanation only; never includes a token, URL query, or raw provider response. */
    reason: string | null
}

/** A node stream wakes the durable delivery pump; application handling still precedes acknowledgement. */
export interface RelayRealtime {
    start(wake: () => void): void
    stop(): void
    status(): RelayDeliveryStatus
    pending(): { deliveryId: string; messageId: string }[]
    acknowledgeMessage(messageId: string): void
}

/** One authenticated agent identity (agent token). */
export interface RelayAgentClient {
    readonly identity: RelayIdentity
    readonly realtime?: RelayRealtime
    joinChannel(channel: string): Promise<void>
    postToChannel(channel: string, text: string, data: Record<string, unknown>, idempotencyKey: string): Promise<RelayPostResult>
    sendDm(to: RelayIdentity, text: string, data: Record<string, unknown>, idempotencyKey: string): Promise<RelayPostResult>
    /** Fetch queued deliveries for this identity, resolving each message's metadata. Does NOT ack. */
    pollDeliveries(limit: number): Promise<RelayInboundMessage[]>
    ack(deliveryId: string): Promise<void>
}

/** Workspace-level operations + the per-identity clients. */
export interface RelayTransport {
    readonly kind: "live" | "memory"
    readonly workspaceId: string | null
    deliveryStatus?(): RelayDeliveryStatus
    /** Create the channel if missing (workspace key). Idempotent. */
    ensureChannel(channel: string, topic: string): Promise<void>
    /** Clients for every identity, registered once and persisted (live: .local/relay-identities.json, 0600). */
    agent(identity: RelayIdentity): RelayAgentClient
    /** Read channel history (workspace key) — used for catch-up after a restart. */
    history(channel: string, afterMessageId: string | null, limit: number): Promise<RelayInboundMessage[]>
}

export type RelayErrorCode = "network" | "auth" | "rate-limited" | "not-found" | "conflict" | "server" | "invalid-response"

export class RelayError extends Error {
    readonly code: RelayErrorCode
    readonly status: number | null
    readonly retryable: boolean
    constructor(code: RelayErrorCode, message: string, status: number | null, retryable: boolean) {
        super(message)
        this.name = "RelayError"
        this.code = code
        this.status = status
        this.retryable = retryable
    }
}

// ---------------------------------------------------------------------------------------------
// Delivery pump: node push wakes a serialized durable-delivery consumer, with bounded catch-up
// and adaptive polling when WS is unsupported/disconnected (implemented in ./deliveryPump.ts).
// ---------------------------------------------------------------------------------------------

/** "ack" → acknowledge; "retry" → leave queued (it will be redelivered); handlers must be idempotent. */
export type DeliveryHandler = (message: RelayInboundMessage) => Promise<"ack" | "retry">

export interface DeliveryPump {
    readonly identity: RelayIdentity
    start(): void
    stop(): Promise<void>
    /** Wake now after an outbound post; polling fallback also accelerates briefly (~250 ms). */
    boost(): void
    /** Fallback cadence: idle ~1.5 s, paused ~5 s. Healthy WS reconciles at most every 30 s. */
    setCadence(cadence: "active" | "idle" | "paused"): void
    /** p50 of measured message-creation → receipt delay, for honest labelling. */
    measuredDelayP50Ms(): number | null
}

/** Shared group so one outbound post can boost every identity's pump. */
export interface DeliveryPumpGroup {
    add(pump: DeliveryPump): void
    boostAll(): void
    setCadenceAll(cadence: "active" | "idle" | "paused"): void
    stopAll(): Promise<void>
    measuredDelayP50Ms(): number | null
}
