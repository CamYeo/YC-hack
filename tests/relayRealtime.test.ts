import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLiveRelay, type relayRequest } from "../server/providers/relay/liveRelay"
import { createRelayNodeStream, type RelayNodeSocket } from "../server/providers/relay/nodeStream"
import { createDeliveryPump } from "../server/providers/relay/deliveryPump"
import { createMemoryRelay } from "../server/providers/relay/memoryRelay"
import type { RelayAgentClient } from "../server/providers/relay/types"

class FakeSocket implements RelayNodeSocket {
    readyState = 0
    onopen: WebSocket["onopen"] = null
    onclose: WebSocket["onclose"] = null
    onerror: WebSocket["onerror"] = null
    onmessage: WebSocket["onmessage"] = null
    sent: Record<string, unknown>[] = []
    send(data: string) { this.sent.push(JSON.parse(data) as Record<string, unknown>) }
    close() { this.readyState = 3 }
    open() {
        this.readyState = 1
        this.onopen?.call(this as unknown as WebSocket, new Event("open"))
        const register = this.sent.find(frame => frame.type === "node.register")
        this.receive({ v: 1, type: "reply", id: register?.id, ok: true, data: {} })
    }
    receive(data: unknown) { this.onmessage?.call(this as unknown as WebSocket, new MessageEvent("message", { data: JSON.stringify(data) })) }
    lose() { this.readyState = 3; this.onclose?.call(this as unknown as WebSocket, new CloseEvent("close")) }
    deliver(seq: number, id: string) { this.receive({ v: 1, type: "deliver", agent: "agent-test", seq, payload: { type: "message.created", data: { id, channel_name: "qa-test", text: "QA fixture" } } }) }
    acks() { return this.sent.filter(frame => frame.type === "delivery.ack").map(frame => frame.up_to_seq) }
}
const until = async (check: () => boolean, timeout = 1000) => {
    const end = Date.now() + timeout
    while (!check()) { if (Date.now() > end) throw new Error("Fixture condition timed out"); await Bun.sleep(2) }
}
const fixture = (reason: string | null = null) => {
    const sockets: FakeSocket[] = []
    const stream = createRelayNodeStream({
        baseUrl: "https://relay.invalid/v1",
        token: async () => ({ nodeId: "node_direct_fixture", nodeName: "fixture", token: "fixture-only-not-a-credential" }),
        unavailableReason: async () => reason,
        socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
        timing: { reconnectBase: 5, reconnectMax: 10, handshake: 100, heartbeat: 100_000 },
    })
    return { stream, sockets }
}

describe("Relay node stream durable acknowledgement", () => {
    test("registration, push, deferred cumulative ack and replay do not acknowledge unfinished work", async () => {
        const { stream, sockets } = fixture(); let wakes = 0
        stream.start(() => { wakes++ })
        try {
            await until(() => sockets.length === 1)
            const socket = sockets[0]!
            socket.open()
            expect(stream.status()).toEqual({ mode: "websocket", state: "connected", reason: null })
            expect(socket.sent[0]).toMatchObject({ type: "node.register", node_id: "node_direct_fixture", max_agents: 1 })
            socket.deliver(10, "m1"); socket.deliver(11, "m2")
            expect(stream.pending().map(frame => frame.messageId)).toEqual(["m1", "m2"])
            expect(socket.acks()).toEqual([])
            stream.acknowledgeMessage("m2")
            expect(socket.acks()).toEqual([])
            stream.acknowledgeMessage("m1")
            expect(socket.acks()).toEqual([11])
            socket.deliver(10, "m1")
            expect(stream.pending()).toEqual([])
            expect(socket.acks()).toEqual([11, 10])
            expect(wakes).toBeGreaterThan(2)
        } finally { stream.stop() }
    })
    test("disconnect re-registers and keeps unacknowledged frames for catch-up", async () => {
        const { stream, sockets } = fixture(); stream.start(() => {})
        try {
            await until(() => sockets.length === 1); sockets[0]!.open(); sockets[0]!.deliver(1, "m1")
            sockets[0]!.lose()
            expect(stream.status().mode).toBe("polling")
            await until(() => sockets.length === 2); sockets[1]!.open(); sockets[1]!.deliver(1, "m1")
            expect(stream.pending()).toHaveLength(1)
            stream.acknowledgeMessage("m1")
            expect(sockets[1]!.acks()).toEqual([1])
        } finally { stream.stop() }
    })
    test("explicit hosted 501 gives truthful permanent fallback without a reconnect loop", async () => {
        const { stream, sockets } = fixture("Hosted Relay does not support WebSocket delivery (HTTP 501); using durable polling.")
        stream.start(() => {})
        try {
            await until(() => stream.status().state === "unavailable")
            expect(stream.status().mode).toBe("polling"); expect(stream.status().reason).toContain("501")
            await Bun.sleep(25); expect(sockets).toHaveLength(0)
        } finally { stream.stop() }
    })
    test("stopping while credentials are loading prevents a later socket or reconnect", async () => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let opened = 0
        const stream = createRelayNodeStream({ baseUrl: "https://relay.invalid/v1", token: async () => { await gate; return { nodeId: "n", nodeName: "n", token: "fixture" } }, unavailableReason: async () => null, socket: () => { opened++; return new FakeSocket() } })
        stream.start(() => {}); stream.stop(); release(); await Bun.sleep(10)
        expect(opened).toBe(0); expect(stream.status().state).toBe("stopped")
    })
    test("malformed or unsupported delivery is never acknowledged", async () => {
        const { stream, sockets } = fixture(); stream.start(() => {})
        try {
            await until(() => sockets.length === 1); const socket = sockets[0]!; socket.open()
            socket.receive({ type: "deliver", agent: "fixture", seq: 1, payload: { type: "unknown", data: {} } })
            expect(socket.acks()).toEqual([]); expect(stream.status().state).toBe("unavailable")
        } finally { stream.stop() }
    })
})

describe("WebSocket-driven durable delivery pump", () => {
    test("push wakes immediately, durable handler and REST ack precede node ack, idle polling is bounded", async () => {
        const relay = createMemoryRelay(); const { stream, sockets } = fixture()
        const base = relay.agent("theo"); let polls = 0; let handled = 0; let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const client: RelayAgentClient = { ...base, realtime: stream, async pollDeliveries(limit) { polls++; return base.pollDeliveries(limit) }, async ack(id) {
            const message = (await base.pollDeliveries(100)).find(item => item.deliveryId === id)
            await base.ack(id)
            if (message) stream.acknowledgeMessage(message.messageId)
        } }
        const pump = createDeliveryPump({ client, handler: async () => { handled++; await gate; return "ack" }, reconcileMs: 10_000 })
        pump.start()
        try {
            await until(() => sockets.length === 1); const socket = sockets[0]!; socket.open(); await Bun.sleep(10)
            const idlePolls = polls; await Bun.sleep(25); expect(polls).toBe(idlePolls)
            const sent = await relay.agent("maya").sendDm("theo", "QA fixture", { eventId: "ws-qa" }, "ws-qa")
            socket.deliver(1, sent.messageId)
            await until(() => handled === 1)
            expect(socket.acks()).toEqual([]); expect(await base.pollDeliveries(10)).toHaveLength(1)
            socket.deliver(1, sent.messageId); release()
            await until(() => socket.acks().length === 1)
            expect(await base.pollDeliveries(10)).toHaveLength(0); expect(handled).toBe(1)
        } finally { release(); await pump.stop() }
    })
    test("reconnect catches messages missed without a push and retries a failed REST acknowledgement", async () => {
        const relay = createMemoryRelay(); const base = relay.agent("theo"); const { stream, sockets } = fixture()
        let ackCalls = 0; const effects = new Set<string>(); let handlerCalls = 0
        const client: RelayAgentClient = { ...base, realtime: stream, async ack(id) {
            ackCalls++; if (ackCalls === 1) throw new Error("Temporary REST ack failure")
            const message = (await base.pollDeliveries(100)).find(item => item.deliveryId === id)
            await base.ack(id); if (message) stream.acknowledgeMessage(message.messageId)
        } }
        const pump = createDeliveryPump({ client, handler: async message => { handlerCalls++; effects.add(message.messageId); return "ack" }, timing: { active: 5, idle: 5, paused: 10, boosted: 2, boostDuration: 20 }, reconcileMs: 10_000 })
        pump.start()
        try {
            await until(() => sockets.length === 1); sockets[0]!.open(); await Bun.sleep(10)
            sockets[0]!.lose()
            const posted = await relay.agent("maya").sendDm("theo", "QA missed push", { eventId: "missed" }, "missed")
            await until(() => sockets.length === 2); sockets[1]!.open()
            await until(() => ackCalls >= 2)
            expect(effects.size).toBe(1); expect(handlerCalls).toBe(2)
            // A late replay after successful REST acknowledgement is acknowledged without repeating work.
            sockets[1]!.deliver(1, posted.messageId)
            expect(sockets[1]!.acks()).toEqual([1])
        } finally { await pump.stop() }
    })
    test("a retry preserves delivery order and fallback continues without WebSocket support", async () => {
        const relay = createMemoryRelay(); const { stream } = fixture("HTTP 501: polling fallback")
        await relay.agent("maya").sendDm("theo", "first", {}, "first")
        await relay.agent("maya").sendDm("theo", "second", {}, "second")
        const seen: string[] = []
        const pump = createDeliveryPump({ client: { ...relay.agent("theo"), realtime: stream }, handler: async message => { seen.push(message.text); return seen.length === 1 ? "retry" : "ack" }, timing: { active: 5, idle: 5, paused: 10, boosted: 2, boostDuration: 20 } })
        pump.start()
        try { await until(() => seen.length === 3); expect(seen).toEqual(["first", "first", "second"]); expect(stream.status().state).toBe("unavailable") }
        finally { await pump.stop() }
    })
    test("healthy stream still reconciles missed notifications at the configured bounded interval", async () => {
        const relay = createMemoryRelay(); const { stream, sockets } = fixture(); let handled = 0
        const pump = createDeliveryPump({ client: { ...relay.agent("theo"), realtime: stream }, handler: async () => { handled++; return "ack" }, reconcileMs: 20 })
        pump.start()
        try {
            await until(() => sockets.length === 1); sockets[0]!.open(); await Bun.sleep(10)
            await relay.agent("maya").sendDm("theo", "QA no notification", {}, "quiet")
            await until(() => handled === 1)
        } finally { await pump.stop() }
    })
})

describe("live adapter protocol with injected HTTP and node transports", () => {
    test("canonical metadata wins over push payload and a restart recovers the REST-ack/node-ack crash window", async () => {
        const root = mkdtempSync(join(tmpdir(), "apprentice-relay-protocol-"))
        const sockets: FakeSocket[] = []
        const config = { baseUrl: "https://armadillo.agentrelay.com/v1", workspaceKey: "fixture-only", workspaceId: "workspace-fixture", keySource: "env-file" } as const
        let restPending = true; let restAcks = 0; let canonicalReads = 0
        const request: typeof relayRequest = async (_base, _token, method, path, body) => {
            if (path === "/workspace") return { id: "workspace-fixture" }
            if (path === "/agents") { const name = (body as { name: string }).name; return { id: `agent-${name}`, token: `fixture-${name}` } }
            if (path === "/agent/node-token") return { node_id: "node_direct_fixture", node_name: "fixture", token: "fixture-only" }
            if (path === "/agents/heartbeat") return {}
            if (path.startsWith("/deliveries?")) return restPending ? [{ id: "delivery-one", message_id: "message-one" }] : []
            if (path === "/messages/message-one") { canonicalReads++; return { id: "message-one", channel_id: "channel-fixture", channel_name: "qa", agent_name: "maya", text: "Canonical text", metadata: { eventId: "durable-event", trustedSource: "REST" }, created_at: new Date().toISOString() } }
            if (path === "/deliveries/delivery-one/ack" && method === "POST") { restAcks++; restPending = false; return {} }
            throw new Error(`Unexpected fixture route: ${method} ${path}`)
        }
        const create = () => createLiveRelay(config, root, { request, unavailableReason: async () => null, nodeSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
        let first: Awaited<ReturnType<typeof create>> | null = null
        let second: Awaited<ReturnType<typeof create>> | null = null
        try {
            first = await create(); const firstClient = first.agent("theo")
            firstClient.realtime!.start(() => {}); await until(() => sockets.length === 1); sockets[0]!.open(); sockets[0]!.deliver(1, "message-one")
            const received = await firstClient.pollDeliveries(100)
            expect(received).toHaveLength(1)
            expect(received[0]!.text).toBe("Canonical text")
            expect(received[0]!.metadata).toEqual({ eventId: "durable-event", trustedSource: "REST" })
            expect(sockets[0]!.acks()).toEqual([])
            // Simulate process loss precisely after the provider REST row was acknowledged.
            const durableProcessed = new Set([received[0]!.messageId])
            firstClient.realtime!.stop()
            await firstClient.ack(received[0]!.deliveryId)
            expect(restAcks).toBe(1); expect(sockets[0]!.acks()).toEqual([])
            second = await create(); const secondClient = second.agent("theo")
            secondClient.realtime!.start(() => {}); await until(() => sockets.length === 2); sockets[1]!.open(); sockets[1]!.deliver(1, "message-one")
            const replay = await secondClient.pollDeliveries(100)
            expect(replay).toHaveLength(1); expect(replay[0]!.deliveryId).toStartWith("node:")
            expect(durableProcessed.has(replay[0]!.messageId)).toBe(true)
            await secondClient.ack(replay[0]!.deliveryId)
            expect(restAcks).toBe(1); expect(sockets[1]!.acks()).toEqual([1])
            expect(await secondClient.pollDeliveries(100)).toHaveLength(0)
            expect(canonicalReads).toBe(2)
            expect(second.deliveryStatus?.().mode).toBe("websocket")
        } finally {
            first?.agent("theo").realtime?.stop(); second?.agent("theo").realtime?.stop()
            rmSync(root, { recursive: true, force: true })
        }
    })
})
