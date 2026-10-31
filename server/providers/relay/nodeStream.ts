import type { RelayDeliveryStatus, RelayRealtime } from "./types"

export interface RelayNodeToken { nodeId: string; nodeName: string; token: string }
export interface RelayNodeSocket {
    readyState: number
    onopen: WebSocket["onopen"]
    onmessage: WebSocket["onmessage"]
    onclose: WebSocket["onclose"]
    onerror: WebSocket["onerror"]
    send(data: string): void
    close(): void
}
export interface RelayNodeStreamOptions {
    baseUrl: string
    token: () => Promise<RelayNodeToken>
    /** Returns only a safe reason for an explicitly unsupported host; unknown/transient errors return null. */
    unavailableReason: (token: RelayNodeToken) => Promise<string | null>
    onConnected?: () => Promise<void>
    socket?: (url: string) => RelayNodeSocket
    timing?: { reconnectBase: number; reconnectMax: number; handshake: number; heartbeat: number }
}
interface Frame { agent: string; seq: number; messageId: string; deliveryId: string; acknowledged: boolean }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

/**
 * Relaycast 12.3 node protocol, deliberately using explicit acknowledgements.
 * SDK AgentClient enables autoAckDeliveries and acknowledges before async handlers finish;
 * WsClient with autoAck=false hides the node seq, so neither can preserve our durable-work boundary.
 * https://dev.agentrelay.com/docs/nodes and installed @relaycast/sdk/dist/ws.js are the protocol sources.
 */
export function createRelayNodeStream(options: RelayNodeStreamOptions): RelayRealtime {
    const timing = options.timing ?? { reconnectBase: 1000, reconnectMax: 30_000, handshake: 10_000, heartbeat: 27_000 }
    const socketFactory = options.socket ?? (url => new WebSocket(url))
    let status: RelayDeliveryStatus = { mode: "polling", state: "stopped", reason: null }
    let running = false
    let generation = 0
    let wake = () => {}
    let socket: RelayNodeSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | null = null
    let handshake: ReturnType<typeof setTimeout> | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let attempts = 0
    const frames = new Map<string, Frame>()
    const acknowledgedMessages = new Set<string>()
    const notify = (next: RelayDeliveryStatus) => { status = next; wake() }
    const clearTimers = () => {
        if (reconnect) clearTimeout(reconnect)
        if (handshake) clearTimeout(handshake)
        if (heartbeat) clearInterval(heartbeat)
        reconnect = handshake = heartbeat = null
    }
    const detach = () => {
        const previous = socket
        socket = null
        if (previous) { previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null; previous.close() }
    }
    const flushAcknowledgements = () => {
        if (!socket || socket.readyState !== 1 || status.state !== "connected") return
        const agents = new Set([...frames.values()].map(frame => frame.agent))
        for (const agent of agents) {
            const ordered = [...frames.values()].filter(frame => frame.agent === agent).sort((a, b) => a.seq - b.seq)
            let upTo: number | null = null
            for (const frame of ordered) { if (!frame.acknowledged) break; upTo = frame.seq }
            if (upTo === null) continue
            try { socket.send(JSON.stringify({ v: 1, type: "delivery.ack", agent, up_to_seq: upTo })) }
            catch { return } // Keep the frames until reconnect; a failed write cannot advance the cursor.
            for (const [key, frame] of frames) if (frame.agent === agent && frame.seq <= upTo) frames.delete(key)
        }
    }
    const unavailable = (reason: string) => {
        generation++; clearTimers(); detach()
        notify({ mode: "polling", state: "unavailable", reason })
    }
    const connect = async () => {
        const current = ++generation
        let credentials: RelayNodeToken | null = null
        let failed = false
        const currentConnection = () => running && generation === current
        const fail = async () => {
            if (!currentConnection() || failed) return
            failed = true; clearTimers(); detach()
            notify({ mode: "polling", state: "reconnecting", reason: "Relay stream reconnecting; durable polling is active." })
            const reason = credentials ? await options.unavailableReason(credentials).catch(() => null) : null
            if (!currentConnection()) return
            if (reason) { unavailable(reason); return }
            attempts++
            const delay = Math.min(timing.reconnectMax, timing.reconnectBase * 2 ** Math.min(attempts - 1, 8) * (0.75 + Math.random() * 0.5))
            reconnect = setTimeout(() => { reconnect = null; void connect() }, delay)
        }
        try {
            credentials = await options.token()
            if (!currentConnection()) return
            const knownUnavailable = await options.unavailableReason(credentials)
            if (!currentConnection()) return
            if (knownUnavailable) { unavailable(knownUnavailable); return }
            const url = new URL(`${options.baseUrl}/node/ws`)
            url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
            url.searchParams.set("token", credentials.token)
            const next = socketFactory(url.toString())
            socket = next
            const node = credentials
            let lastFrameAt = Date.now()
            const registrationId = `apprentice-node-${crypto.randomUUID()}`
            handshake = setTimeout(() => { void fail() }, timing.handshake)
            next.onopen = () => {
                if (!currentConnection()) return
                try { next.send(JSON.stringify({ v: 1, id: registrationId, type: "node.register", node_id: node.nodeId, name: node.nodeName, capabilities: [], max_agents: 1, tags: ["implicit", "direct", "apprentice"], version: "apprentice/1" })) }
                catch { void fail() }
            }
            const registered = () => {
                if (status.state === "connected") return
                if (handshake) clearTimeout(handshake)
                handshake = null; attempts = 0
                notify({ mode: "websocket", state: "connected", reason: null })
                void options.onConnected?.().catch(() => {})
                flushAcknowledgements()
                heartbeat = setInterval(() => {
                    if (Date.now() - lastFrameAt > timing.heartbeat * 2) { void fail(); return }
                    if (next.readyState === 1) {
                        try { next.send(JSON.stringify({ v: 1, id: `apprentice-heartbeat-${crypto.randomUUID()}`, type: "node.heartbeat", node_id: node.nodeId, load: null, active_agents: 1, handlers_live: false })) }
                        catch { void fail() }
                    }
                }, timing.heartbeat)
            }
            next.onmessage = event => {
                if (!currentConnection() || typeof event.data !== "string") return
                let value: unknown
                try { value = JSON.parse(event.data) } catch { return }
                if (!record(value)) return
                lastFrameAt = Date.now()
                if (value.type === "reply" && value.id === registrationId) {
                    if (value.ok === true) registered()
                    else void fail()
                    return
                }
                if (value.type === "error") { void fail(); return }
                if (value.type !== "deliver") return
                const payload = record(value.payload) ? value.payload : null
                const data = payload && record(payload.data) ? payload.data : null
                const message = data && record(data.message) ? data.message : null
                const messageId = message?.id ?? data?.id
                const kind = payload?.type
                if (typeof value.agent !== "string" || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0 || typeof messageId !== "string" || !messageId || !["message.created", "thread.reply", "dm.received", "group_dm.received"].includes(String(kind))) {
                    unavailable("Relay sent an unsupported node delivery; using durable polling without acknowledging that frame.")
                    return
                }
                registered()
                const key = `${value.agent}:${value.seq}`
                const previous = frames.get(key)
                if (previous && previous.messageId !== messageId) { unavailable("Relay reused a delivery sequence; using durable polling."); return }
                if (!previous) frames.set(key, { agent: value.agent, seq: value.seq, messageId, deliveryId: `node:${key}`, acknowledged: acknowledgedMessages.has(messageId) })
                flushAcknowledgements()
                if (frames.size > 1000) { unavailable("Relay stream backlog exceeded its bounded buffer; using durable polling."); return }
                wake()
            }
            next.onerror = next.onclose = () => { void fail() }
        } catch { void fail() }
    }
    return {
        start(callback) {
            if (running) return
            running = true; wake = callback
            notify({ mode: "polling", state: "connecting", reason: "Connecting Relay stream; durable polling is active." })
            void connect()
        },
        stop() { running = false; generation++; clearTimers(); detach(); status = { mode: "polling", state: "stopped", reason: null }; wake = () => {} },
        status: () => ({ ...status }),
        pending: () => [...frames.values()].filter(frame => !frame.acknowledged).map(({ deliveryId, messageId }) => ({ deliveryId, messageId })),
        acknowledgeMessage(messageId) {
            acknowledgedMessages.add(messageId)
            if (acknowledgedMessages.size > 2048) { const first = acknowledgedMessages.values().next().value; if (first) acknowledgedMessages.delete(first) }
            for (const frame of frames.values()) if (frame.messageId === messageId) frame.acknowledged = true
            flushAcknowledgements()
        },
    }
}
