import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RelayIdentity } from "../../../shared/contracts"
import type { RelayConfig } from "../../config/types"
import { relayBaseUrl } from "../../config/hackathonConfig"
import { RelayError, type RelayAgentClient, type RelayInboundMessage, type RelayTransport } from "./types"
import { createRelayNodeStream, type RelayNodeStreamOptions, type RelayNodeToken } from "./nodeStream"

const identities: RelayIdentity[] = ["facilitator", "maya", "theo", "evidence", "bridge", "learner"]
export class AnonymousIdempotencyUnavailableError extends RelayError {
    constructor() { super("server", "Anonymous workspace create idempotency is not configured on this Relay deployment", 503, false) }
}
type JsonObject = Record<string, unknown>
export function isRecord(value: unknown): value is JsonObject { return !!value && typeof value === "object" && !Array.isArray(value) }
function stringField(obj: JsonObject, key: string): string {
    const value = obj[key]
    if (typeof value !== "string" || !value) throw new RelayError("invalid-response", `Relay response missing ${key}`, null, false)
    return value
}
export function savePrivateJson(path: string, data: unknown): void {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, path)
    chmodSync(path, 0o600)
}
export async function relayRequest(baseUrl: string, token: string | null, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (token) headers.Authorization = `Bearer ${token}`
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey
    for (let attempt = 0; ; attempt++) {
        let response: Response
        try {
            response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000), redirect: "error" })
        } catch {
            if (attempt === 0 && (method === "GET" || idempotencyKey)) { await Bun.sleep(300); continue }
            throw new RelayError("network", "Agent Relay could not be reached", null, true)
        }
        if (!response.ok) {
            const code = response.status === 401 || response.status === 403 ? "auth" : response.status === 404 ? "not-found" : response.status === 409 ? "conflict" : response.status === 429 ? "rate-limited" : "server"
            const retryable = response.status === 429 || response.status >= 500
            // Inspect only a known, non-secret error code. Never surface arbitrary response bodies.
            const errorBody: unknown = await response.json().catch(() => null)
            if (path === "/workspaces" && !token && idempotencyKey && response.status === 503 && isRecord(errorBody) && isRecord(errorBody.error) && errorBody.error.code === "workspace_create_idempotency_unavailable") throw new AnonymousIdempotencyUnavailableError()
            if (attempt === 0 && retryable && (method === "GET" || idempotencyKey)) { await Bun.sleep(500); continue }
            throw new RelayError(code, `Agent Relay request failed (${response.status})`, response.status, retryable)
        }
        let envelope: unknown
        try { envelope = await response.json() } catch { throw new RelayError("invalid-response", "Agent Relay returned invalid JSON", response.status, false) }
        if (!isRecord(envelope) || envelope.ok !== true || !("data" in envelope)) throw new RelayError("invalid-response", "Agent Relay returned an invalid response envelope", response.status, false)
        return envelope.data
    }
}

export interface LiveRelayOptions {
    /** Deterministic protocol tests; production always uses the authenticated REST/node transports. */
    request?: typeof relayRequest
    nodeSocket?: RelayNodeStreamOptions["socket"]
    unavailableReason?: RelayNodeStreamOptions["unavailableReason"]
}
export async function createLiveRelay(config: RelayConfig, repoRoot: string, options: LiveRelayOptions = {}): Promise<RelayTransport> {
    const api = options.request ?? relayRequest
    const baseUrl = relayBaseUrl(config.baseUrl, config.workspaceKey)
    const workspace = await api(baseUrl, config.workspaceKey, "GET", "/workspace")
    if (!isRecord(workspace)) throw new RelayError("invalid-response", "Relay workspace response missing", null, false)
    const workspaceId = config.workspaceId || (typeof workspace.id === "string" ? workspace.id : typeof workspace.workspace_id === "string" ? workspace.workspace_id : null)
    if (!workspaceId) throw new RelayError("invalid-response", "Relay workspace id missing", null, false)
    const directory = join(repoRoot, ".local")
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
    const identityPath = join(directory, "relay-identities.json")
    const saved: { workspaceId: string; baseUrl: string; agents: Partial<Record<RelayIdentity, { id: string; token: string }>> } = { workspaceId, baseUrl, agents: {} }
    if (existsSync(identityPath)) {
        let value: unknown
        try { value = JSON.parse(readFileSync(identityPath, "utf8")) } catch { throw new RelayError("invalid-response", "Local Relay identity file is malformed", null, false) }
        if (!isRecord(value) || value.workspaceId !== workspaceId || value.baseUrl !== baseUrl || !isRecord(value.agents)) throw new RelayError("conflict", "Local Relay identities belong to another workspace; preserve that file before reconfiguring", null, false)
        for (const identity of identities) {
            const item = value.agents[identity]
            if (isRecord(item) && typeof item.id === "string" && typeof item.token === "string") saved.agents[identity] = { id: item.id, token: item.token }
        }
    }
    for (const identity of identities) {
        if (saved.agents[identity]) continue
        const data = await api(baseUrl, config.workspaceKey, "POST", "/agents", {
            name: identity, type: identity === "learner" ? "human" : identity === "bridge" ? "system" : "agent",
            persona: `APPRENTICE hackathon seminar ${identity}`,
        })
        if (!isRecord(data)) throw new RelayError("invalid-response", "Relay registration response missing", null, false)
        saved.agents[identity] = { id: stringField(data, "id"), token: stringField(data, "token") }
        savePrivateJson(identityPath, saved)
    }
    const channels = new Map<string, string>()
    const posted = new Map<string, string>()
    // One safe capability check per transport, shared by its identities. A 501 is permanent
    // for this process; restarting is the explicit way to retry a changed host deployment.
    let capability: Promise<string | null> | null = null
    const unavailableReason = options.unavailableReason ?? ((node: RelayNodeToken) => {
        capability ??= (async () => {
            try {
                const url = new URL(`${baseUrl}/node/ws`)
                url.searchParams.set("token", node.token)
                const response = await fetch(url, { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64") }, signal: AbortSignal.timeout(5000), redirect: "error" })
                if (response.status === 501) return "Hosted Relay does not support WebSocket delivery (HTTP 501); using durable polling."
                if (response.status === 101 || response.status === 426) { await response.body?.cancel(); return null }
                const body: unknown = await response.json().catch(() => null)
                if (isRecord(body) && isRecord(body.error) && body.error.code === "websocket_unavailable") return "Hosted Relay WebSocket delivery is unavailable; using durable polling."
            } catch { /* An upgrade response or a transient network failure is not evidence of unsupported WS. */ }
            return null
        })()
        return capability
    })
    function inbound(message: JsonObject, deliveryId: string, deliveryChannel?: string): RelayInboundMessage {
        const channelId = typeof message.channel_id === "string" ? message.channel_id : deliveryChannel || ""
        const isDm = channelId.startsWith("dmch_") || !channelId
        const createdAt = typeof message.created_at === "string" ? message.created_at : new Date().toISOString()
        const age = Date.now() - Date.parse(createdAt)
        return {
            deliveryId, messageId: stringField(message, "id"),
            channel: isDm ? null : typeof message.channel_name === "string" ? message.channel_name : channels.get(channelId) || null,
            isDm, senderName: stringField(message, "agent_name"), text: typeof message.text === "string" ? message.text : "",
            metadata: isRecord(message.metadata) ? message.metadata : null,
            createdAt, deliveryDelayMs: Number.isFinite(age) ? Math.max(0, age) : null,
        }
    }
    const clients = new Map<RelayIdentity, RelayAgentClient>()
    for (const identity of identities) {
        const registered = saved.agents[identity]
        if (!registered) throw new RelayError("invalid-response", "Relay identity registration is missing", null, false)
        const token = registered.token
        const request = (method: string, path: string, body?: unknown, key?: string) => api(baseUrl, token, method, path, body, key)
        let nodeToken: RelayNodeToken | null = null
        let tokenUses = 0
        const realtime = createRelayNodeStream({ baseUrl, unavailableReason, socket: options.nodeSocket,
            onConnected: async () => { tokenUses = 0; await request("POST", "/agents/heartbeat", {}) },
            token: async () => {
            if (!nodeToken || tokenUses >= 3) {
                const raw = await request("POST", "/agent/node-token", {})
                if (!isRecord(raw)) throw new RelayError("invalid-response", "Relay node token response missing", null, false)
                nodeToken = { nodeId: stringField(raw, "node_id"), nodeName: stringField(raw, "node_name"), token: stringField(raw, "token") }
                tokenUses = 0
            }
            tokenUses++
            return nodeToken
        } })
        const deliveryMessages = new Map<string, string>()
        const post = async (path: string, body: unknown, key: string) => {
            const began = performance.now()
            const response = await request("POST", path, body, key)
            if (!isRecord(response)) throw new RelayError("invalid-response", "Relay post response missing", null, false)
            const inner = isRecord(response.message) ? response.message : response
            const messageId = stringField(inner, "id")
            const cacheKey = `${identity}:${path}:${key}`
            const replayed = posted.get(cacheKey) === messageId
            posted.set(cacheKey, messageId)
            return { messageId, replayed, latencyMs: Math.round(performance.now() - began) }
        }
        clients.set(identity, {
            identity, realtime,
            async joinChannel(channel) { await request("POST", `/channels/${encodeURIComponent(channel)}/join`) },
            async postToChannel(channel, text, data, key) { return post(`/channels/${encodeURIComponent(channel)}/messages`, { text, data, mode: "wait" }, key) },
            async sendDm(to, text, data, key) { return post("/dm", { to, text, data, mode: "wait" }, key) },
            async pollDeliveries(limit) {
                const raw = await request("GET", `/deliveries?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`)
                if (!Array.isArray(raw)) throw new RelayError("invalid-response", "Relay deliveries must be an array", null, false)
                const output: RelayInboundMessage[] = []
                const seenMessages = new Set<string>()
                for (const delivery of raw) {
                    if (!isRecord(delivery)) throw new RelayError("invalid-response", "Malformed Relay delivery", null, false)
                    const messageId = typeof delivery.message_id === "string" ? delivery.message_id : isRecord(delivery.message) ? stringField(delivery.message, "id") : ""
                    if (!messageId) throw new RelayError("invalid-response", "Relay delivery has no message id", null, false)
                    const message = await request("GET", `/messages/${encodeURIComponent(messageId)}`)
                    if (!isRecord(message)) throw new RelayError("invalid-response", "Relay message missing", null, false)
                    const deliveryId = stringField(delivery, "id")
                    deliveryMessages.set(deliveryId, messageId)
                    seenMessages.add(messageId)
                    output.push(inbound(message, deliveryId, typeof delivery.channel_id === "string" ? delivery.channel_id : undefined))
                }
                // A crash can happen after the REST ack but before the node ack. Replay the
                // canonical message through the idempotent handler even if its REST row is gone.
                // Never treat push payloads as trusted application envelopes or skip validation.
                for (const pending of realtime.pending()) {
                    if (output.length >= limit) break
                    if (seenMessages.has(pending.messageId)) continue
                    const message = await request("GET", `/messages/${encodeURIComponent(pending.messageId)}`)
                    if (!isRecord(message)) throw new RelayError("invalid-response", "Relay replay message missing", null, false)
                    seenMessages.add(pending.messageId)
                    deliveryMessages.set(pending.deliveryId, pending.messageId)
                    output.push(inbound(message, pending.deliveryId))
                }
                return output
            },
            async ack(deliveryId) {
                const messageId = deliveryMessages.get(deliveryId)
                if (!deliveryId.startsWith("node:")) await request("POST", `/deliveries/${encodeURIComponent(deliveryId)}/ack`)
                if (messageId) { realtime.acknowledgeMessage(messageId); deliveryMessages.delete(deliveryId) }
            },
        })
    }
    return {
        kind: "live", workspaceId,
        deliveryStatus() {
            const states = [...clients.values()].flatMap(client => client.realtime ? [client.realtime.status()] : []).filter(status => status.state !== "stopped")
            return states.find(status => status.state === "unavailable") ?? states.find(status => status.mode === "polling") ?? states[0] ?? { mode: "polling", state: "stopped", reason: null }
        },
        async ensureChannel(channel, topic) {
            let data: unknown
            try { data = await api(baseUrl, config.workspaceKey, "GET", `/channels/${encodeURIComponent(channel)}`) }
            catch (error) {
                if (!(error instanceof RelayError) || error.code !== "not-found") throw error
                try { data = await api(baseUrl, config.workspaceKey, "POST", "/channels", { name: channel, topic }) }
                catch (creationError) {
                    if (!(creationError instanceof RelayError) || creationError.code !== "conflict") throw creationError
                    data = await api(baseUrl, config.workspaceKey, "GET", `/channels/${encodeURIComponent(channel)}`)
                }
            }
            if (isRecord(data) && typeof data.id === "string") channels.set(data.id, channel)
        },
        agent(identity) { const client = clients.get(identity); if (!client) throw new RelayError("not-found", "Unknown Relay identity", null, false); return client },
        async history(channel, afterMessageId, limit) {
            const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 200))) })
            if (afterMessageId) query.set("after", afterMessageId)
            const data = await api(baseUrl, config.workspaceKey, "GET", `/channels/${encodeURIComponent(channel)}/messages?${query}`)
            if (!Array.isArray(data)) throw new RelayError("invalid-response", "Relay history must be an array", null, false)
            return data.filter(isRecord).map(m => ({ ...inbound(m, `history-${stringField(m, "id")}`), channel, isDm: false })).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId))
        },
    }
}
