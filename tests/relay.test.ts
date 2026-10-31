import { describe, expect, test } from "bun:test"
import { createMemoryRelay } from "../server/providers/relay/memoryRelay"
import { createDeliveryPump, createDeliveryPumpGroup } from "../server/providers/relay/deliveryPump"
import type { RelayAgentClient } from "../server/providers/relay/types"

describe("Relay transport semantics", () => {
    test("channel post preserves sender and metadata, excludes sender, and deduplicates key", async () => {
        const relay = createMemoryRelay()
        await relay.ensureChannel("test", "test"); await relay.agent("maya").joinChannel("test"); await relay.agent("theo").joinChannel("test")
        const first = await relay.agent("maya").postToChannel("test", "A timed-out payment may have succeeded", { eventId: "e1" }, "e1")
        const again = await relay.agent("maya").postToChannel("test", "same operation", { eventId: "e1" }, "e1")
        expect(again.messageId).toBe(first.messageId); expect(again.replayed).toBe(true)
        const pending = await relay.agent("theo").pollDeliveries(10)
        expect(pending).toHaveLength(1); expect(pending[0]!.senderName).toBe("maya"); expect(pending[0]!.metadata).toEqual({ eventId: "e1" })
        expect(await relay.agent("maya").pollDeliveries(10)).toHaveLength(0)
        await relay.agent("theo").ack(pending[0]!.deliveryId); await relay.agent("theo").ack(pending[0]!.deliveryId)
        expect(await relay.agent("theo").pollDeliveries(10)).toHaveLength(0)
    })
    test("DM goes only to addressed identity and remains queued until ack", async () => {
        const relay = createMemoryRelay()
        await relay.agent("theo").sendDm("evidence", "Run the experiment", { requestId: "e1" }, "e1")
        const pending = await relay.agent("evidence").pollDeliveries(10)
        expect(pending[0]!.isDm).toBe(true); expect(pending[0]!.channel).toBeNull()
        expect(await relay.agent("evidence").pollDeliveries(10)).toEqual(pending)
        expect(await relay.agent("bridge").pollDeliveries(10)).toHaveLength(0)
    })
    test("pump retries unhandled delivery without overlapping handlers or duplicate acknowledgement", async () => {
        const relay = createMemoryRelay(); await relay.agent("maya").sendDm("theo", "hello", { eventId: "retry" }, "retry")
        let attempts = 0; let concurrent = 0; let maxConcurrent = 0
        let done!: () => void
        const finished = new Promise<void>(resolve => { done = resolve })
        const group = createDeliveryPumpGroup()
        const pump = createDeliveryPump({ client: relay.agent("theo"), group, timing: { active: 5, idle: 5, paused: 10, boosted: 1, boostDuration: 100 }, handler: async () => {
            concurrent++; maxConcurrent = Math.max(concurrent, maxConcurrent); attempts++; await Bun.sleep(10); concurrent--
            if (attempts === 1) return "retry"
            done(); return "ack"
        } })
        pump.start(); group.boostAll(); group.boostAll()
        await Promise.race([finished, Bun.sleep(1000).then(() => { throw new Error("Pump timed out") })])
        await group.stopAll()
        expect(attempts).toBe(2); expect(maxConcurrent).toBe(1); expect(await relay.agent("theo").pollDeliveries(10)).toHaveLength(0)
    })
    test("poll error is surfaced and stop prevents further polls", async () => {
        let calls = 0; let errors = 0
        const client: RelayAgentClient = { ...createMemoryRelay().agent("bridge"), async pollDeliveries() { calls++; throw new Error("offline") } }
        const pump = createDeliveryPump({ client, handler: async () => "ack", onError: () => { errors++ }, timing: { active: 5, idle: 5, paused: 10, boosted: 1, boostDuration: 100 } })
        pump.start(); await Bun.sleep(15); await pump.stop(); const stopped = calls; await Bun.sleep(15)
        expect(errors).toBeGreaterThan(0); expect(calls).toBe(stopped)
    })
})
