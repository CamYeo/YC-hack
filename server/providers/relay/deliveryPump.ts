import type { DeliveryHandler, DeliveryPump, DeliveryPumpGroup, RelayAgentClient } from "./types"
import type { Logger } from "../../log"

const measuredDelays = new WeakMap<DeliveryPump, number[]>()
export interface DeliveryPumpOptions {
    client: RelayAgentClient
    handler: DeliveryHandler
    onError?: (error: unknown) => void
    logger?: Logger
    group?: DeliveryPumpGroup
    /** Override timing only for deterministic, fast fixture tests. */
    timing?: { active: number; idle: number; paused: number; boosted: number; boostDuration: number }
    /** Bounded reconciliation catches missed push notifications, including silent disconnects. */
    reconcileMs?: number
}
export function createDeliveryPump(options: DeliveryPumpOptions): DeliveryPump {
    const timing = options.timing || { active: 800, idle: 1500, paused: 5000, boosted: 250, boostDuration: 4000 }
    let cadence: "active" | "idle" | "paused" = "idle"
    let running = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let busy: Promise<void> | null = null
    let boostedUntil = 0
    let wakePending = false
    let retryPending = false
    const delays: number[] = []
    const fallbackDelay = () => cadence !== "paused" && Date.now() < boostedUntil ? timing.boosted : timing[cadence]
    const delay = () => !retryPending && options.client.realtime?.status().mode === "websocket" ? (options.reconcileMs ?? 30_000) : fallbackDelay()
    const schedule = (ms: number) => {
        if (!running) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = null; wakePending = false
            busy = poll().finally(() => { busy = null; schedule(wakePending ? 0 : delay()) })
        }, ms)
    }
    const wake = () => {
        if (!running) return
        if (busy) { wakePending = true; return }
        schedule(0)
    }
    const poll = async () => {
        retryPending = false
        try {
            const messages = await options.client.pollDeliveries(100)
            for (const message of messages) {
                if (!running) break
                if (message.deliveryDelayMs !== null) { delays.push(message.deliveryDelayMs); if (delays.length > 100) delays.shift() }
                const result = await options.handler(message)
                if (result === "retry") { retryPending = true; break }
                await options.client.ack(message.deliveryId)
            }
            // Bound each batch, but drain backlog without waiting for the reconciliation timer.
            if (messages.length >= 100 && !retryPending) wakePending = true
        } catch (error) {
            retryPending = true
            options.logger?.warn("Relay delivery processing failed", { identity: options.client.identity })
            options.onError?.(error)
        }
    }
    const pump: DeliveryPump = {
        identity: options.client.identity,
        start() { if (running) return; running = true; options.client.realtime?.start(wake); wake() },
        async stop() { running = false; options.client.realtime?.stop(); if (timer) { clearTimeout(timer); timer = null } await busy },
        boost() { boostedUntil = Date.now() + timing.boostDuration; if (cadence !== "paused") wake() },
        setCadence(next) { cadence = next; if (timer) schedule(delay()) },
        measuredDelayP50Ms() { return [...delays].sort((a,b) => a-b)[Math.floor(delays.length / 2)] ?? null },
    }
    measuredDelays.set(pump, delays)
    options.group?.add(pump)
    return pump
}
export function createDeliveryPumpGroup(): DeliveryPumpGroup {
    const pumps = new Set<DeliveryPump>()
    return {
        add(pump) { pumps.add(pump) },
        boostAll() { for (const pump of pumps) pump.boost() },
        setCadenceAll(cadence) { for (const pump of pumps) pump.setCadence(cadence) },
        async stopAll() { await Promise.all([...pumps].map(pump => pump.stop())) },
        measuredDelayP50Ms() { const vals = [...pumps].flatMap(p => measuredDelays.get(p) || []).sort((a,b) => a-b); return vals[Math.floor(vals.length/2)] ?? null },
    }
}
