import type { RelayIdentity } from "../../../shared/contracts"
import { RelayError, type RelayAgentClient, type RelayInboundMessage, type RelayPostResult, type RelayTransport } from "./types"

const identities: RelayIdentity[] = ["facilitator", "maya", "theo", "evidence", "bridge", "learner"]
export function createMemoryRelay(): RelayTransport {
    const channels = new Map<string, Set<RelayIdentity>>()
    const deliveries = new Map<RelayIdentity, RelayInboundMessage[]>(identities.map(id => [id, []]))
    const history = new Map<string, RelayInboundMessage[]>()
    const posts = new Map<string, RelayPostResult>()
    let sequence = 0
    const queue = (identity: RelayIdentity): RelayInboundMessage[] => {
        const entries = deliveries.get(identity)
        if (!entries) throw new RelayError("not-found", "Recipient not found", 404, false)
        return entries
    }
    const send = (sender: RelayIdentity, target: string, isDm: boolean, text: string, data: Record<string, unknown>, key: string): RelayPostResult => {
        const cacheKey = `${sender}:${target}:${key}`
        const previous = posts.get(cacheKey)
        if (previous) return { ...previous, replayed: true }
        const members = channels.get(target)
        const channelHistory = history.get(target)
        if (!isDm && (!members?.has(sender) || !channelHistory)) throw new RelayError("not-found", "Channel not joined", 404, false)
        const messageId = String(++sequence).padStart(12, "0")
        const message: RelayInboundMessage = { deliveryId: "", messageId, channel: isDm ? null : target, isDm, senderName: sender, text, metadata: structuredClone(data), createdAt: new Date().toISOString(), deliveryDelayMs: 0 }
        const recipients = isDm ? [target as RelayIdentity] : [...(members ?? [])].filter(id => id !== sender)
        for (const recipient of recipients) {
            queue(recipient).push({ ...structuredClone(message), deliveryId: `del-${messageId}-${recipient}` })
        }
        if (!isDm) channelHistory?.push(structuredClone(message))
        const result = { messageId, replayed: false, latencyMs: 0 }
        posts.set(cacheKey, result)
        return result
    }
    const clients = new Map<RelayIdentity, RelayAgentClient>()
    for (const identity of identities) clients.set(identity, {
        identity,
        async joinChannel(channel) { const members = channels.get(channel); if (!members) throw new RelayError("not-found", "Channel missing", 404, false); members.add(identity) },
        async postToChannel(channel, text, data, key) { return send(identity, channel, false, text, data, key) },
        async sendDm(to, text, data, key) { return send(identity, to, true, text, data, key) },
        async pollDeliveries(limit) { return structuredClone(queue(identity).slice(0, Math.max(1, Math.min(limit, 200)))) },
        async ack(id) { deliveries.set(identity, queue(identity).filter(d => d.deliveryId !== id)) },
    })
    return {
        kind: "memory", workspaceId: null,
        deliveryStatus: () => ({ mode: "memory", state: "connected", reason: null }),
        async ensureChannel(channel) { if (!channels.has(channel)) { channels.set(channel, new Set()); history.set(channel, []) } },
        agent(identity) { const client = clients.get(identity); if (!client) throw new RelayError("not-found", "Identity missing", 404, false); return client },
        async history(channel, after, limit) { return structuredClone((history.get(channel) || []).filter(m => !after || m.messageId > after).slice(-limit)) },
    }
}
