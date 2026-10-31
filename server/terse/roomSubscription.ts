import type { PublicRoomState } from "../../actor/src/roomTypes"

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"

/** One local backend observer. Grant URLs stay inside this adapter and never reach the browser. */
export async function subscribeToTerseRoom(
    endpoint: string,
    roomId: string,
    onSnapshot: (state: PublicRoomState) => void,
    onError?: (error: Error) => void,
): Promise<() => void> {
    const controller = new AbortController()
    let stopped = false
    let socket: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const report = (message: string) => { if (!stopped) onError?.(new Error(message)) }
    const stop = () => {
        stopped = true
        controller.abort()
        if (retry) clearTimeout(retry)
        retry = null
        socket?.close(1000, "Observer stopped")
        socket = null
    }
    const reconnect = () => {
        if (stopped || retry) return
        retry = setTimeout(() => {
            retry = null
            void connect().catch(() => { report("Terse room subscription is unavailable"); reconnect() })
        }, Math.min(500 * 2 ** attempts++, 5_000))
    }
    async function connect(): Promise<void> {
        const response = await fetch(`${endpoint}/SeminarActor/${encodeURIComponent(roomId)}/find-websocket`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ metadata: { role: "backend" } }), redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        })
        const grant: unknown = await response.json()
        if (!response.ok || !isRecord(grant) || typeof grant.websocketUrl !== "string") throw new Error("Terse observer grant was rejected")
        const url = new URL(grant.websocketUrl)
        if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Terse observer must stay on loopback")
        if (stopped) return
        const connection = new WebSocket(url)
        socket = connection
        await new Promise<void>((resolve, reject) => {
            let opened = false
            const timeout = setTimeout(() => { reject(new Error("Terse observer connection timed out")); connection.close() }, 10_000)
            connection.addEventListener("open", () => { opened = true; attempts = 0; clearTimeout(timeout); resolve() })
            connection.addEventListener("message", event => {
                if (stopped || socket !== connection) return
                try {
                    const message: unknown = JSON.parse(String(event.data))
                    if (!isRecord(message) || message.type !== "snapshot") return
                    const state = message.state
                    if (!isRecord(state) || state.roomId !== roomId || typeof state.sessionId !== "string"
                        || typeof state.version !== "number" || typeof state.generationEpoch !== "number"
                        || !["discussion", "paused", "reflection", "ended"].includes(String(state.phase))
                        || !Array.isArray(state.contributions) || !Array.isArray(state.trace)
                        || "processedEventKeys" in state || "pendingOutbound" in state) throw new Error("Invalid public actor snapshot")
                    onSnapshot(state as unknown as PublicRoomState)
                } catch { report("Terse room subscription received an invalid snapshot") }
            })
            connection.addEventListener("error", () => {
                clearTimeout(timeout)
                if (!opened) reject(new Error("Terse observer connection failed"))
                connection.close()
            })
            connection.addEventListener("close", () => {
                clearTimeout(timeout)
                if (socket === connection) socket = null
                if (!opened) reject(new Error("Terse observer connection closed before acceptance"))
                else if (!stopped) { report("Terse room subscription disconnected"); reconnect() }
            })
        })
    }
    try { await connect() }
    catch (error) { stop(); throw error }
    return stop
}
