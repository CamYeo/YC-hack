import type { RelayTransport, DeliveryPumpGroup, RelayPostResult } from "../providers/relay/types"
import type { RoomStore } from "./roomStore"
import type { Outbox, OutboxSendInput } from "./outbox.types"
import { RelayEnvelopeSchema, RelayIdentitySchema } from "../../shared/contracts"

/** Persist first; transport idempotency makes the network/commit crash window replayable. */
export function createOutbox(relay: RelayTransport, store: RoomStore, pumps: DeliveryPumpGroup): Outbox {
    const sending = new Map<string, Promise<RelayPostResult>>()
    async function deliver(input: OutboxSendInput): Promise<RelayPostResult> {
        const before = await store.getSnapshot(input.roomId)
        const sent = before.processedEventKeys.includes(`outbound:${input.envelope.eventId}`)
        const prior = before.trace.find(t => t.direction === "out" && t.channel === "relay" && t.eventId === input.envelope.eventId && t.relayMessageId)
        if (sent && prior?.relayMessageId) return { messageId: prior.relayMessageId, replayed: true, latencyMs: 0 }
        await store.enqueueOutbound(input.roomId, { eventId: input.envelope.eventId, sender: input.sender, target: input.target, text: input.text, envelopeJson: JSON.stringify(input.envelope), createdAt: Date.now(), attempts: 0 })
        const persisted = (await store.getSnapshot(input.roomId)).pendingOutbound.find(e => e.eventId === input.envelope.eventId)
        const canonical = persisted ? { roomId: input.roomId, sender: RelayIdentitySchema.parse(persisted.sender), target: persisted.target, text: persisted.text, envelope: RelayEnvelopeSchema.parse(JSON.parse(persisted.envelopeJson)) } : input
        if (canonical.envelope.actorId !== canonical.sender || canonical.envelope.roomId !== canonical.roomId) throw new Error("Outbound identity does not match its envelope")
        const client = relay.agent(canonical.sender)
        const result = canonical.target.type === "channel" ? await client.postToChannel(canonical.target.channel, canonical.text, canonical.envelope, canonical.envelope.eventId) : await client.sendDm(RelayIdentitySchema.parse(canonical.target.to), canonical.text, canonical.envelope, canonical.envelope.eventId)
        // Persist the real message ID before removing the pending event.
        await store.appendTrace(input.roomId, [{ channel: "relay", direction: "out", kind: canonical.envelope.kind, from: canonical.sender, to: canonical.target.type === "channel" ? canonical.target.channel : canonical.target.to, relayMessageId: result.messageId, eventId: canonical.envelope.eventId, summary: canonical.text.slice(0, 180), latencyMs: result.latencyMs }])
        await store.markOutboundSent(input.roomId, canonical.envelope.eventId)
        pumps.boostAll()
        return result
    }
    function send(input: OutboxSendInput): Promise<RelayPostResult> {
        const key = `${input.roomId}:${input.envelope.eventId}`
        const pending = sending.get(key)
        if (pending) return pending
        const task = deliver(input)
        sending.set(key, task)
        void task.finally(() => { if (sending.get(key) === task) sending.delete(key) }).catch(() => undefined)
        return task
    }
    return {
        send,
        async flushPending(roomId) {
            let sent = 0
            for (const e of (await store.getSnapshot(roomId)).pendingOutbound) {
                await send({ roomId, sender: RelayIdentitySchema.parse(e.sender), target: e.target, text: e.text, envelope: RelayEnvelopeSchema.parse(JSON.parse(e.envelopeJson)) })
                sent++
            }
            return sent
        },
    }
}
