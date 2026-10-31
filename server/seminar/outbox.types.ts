// Outbox contract (implemented in ./outbox.ts): every Relay post is recorded in the actor first,
// sent with Idempotency-Key = envelope.eventId, then marked sent; a trace entry records the real
// Relay message id. On restart `flushPending` re-sends anything recorded but not confirmed.

import type { OutboundTarget } from "../../actor/src/roomTypes"
import type { RelayEnvelope, RelayIdentity } from "../../shared/contracts"
import type { RelayPostResult } from "../providers/relay/types"

export interface OutboxSendInput {
    roomId: string
    sender: RelayIdentity
    target: OutboundTarget
    /** Human-readable text (shown in Relay UIs); the typed envelope travels in `data`. */
    text: string
    envelope: RelayEnvelope
}

export interface Outbox {
    /** Throws RelayError after bounded retries; callers pause the session on failure (never bypass). */
    send(input: OutboxSendInput): Promise<RelayPostResult>
    flushPending(roomId: string): Promise<number>
}
