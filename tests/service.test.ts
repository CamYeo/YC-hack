import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadHackathonConfig } from "../server/config/hackathonConfig"
import { createMemoryRelay } from "../server/providers/relay/memoryRelay"
import { createDeliveryPumpGroup } from "../server/providers/relay/deliveryPump"
import { SeminarService, type RoomSocket, type ServiceOptions } from "../server/seminar/service"
import { createMemoryRoomStore } from "../server/seminar/memoryRoomStore"
import { createOutbox } from "../server/seminar/outbox"
import type { ClientMessage, CreateRoomRequest, RelayEnvelope, ServerMessage } from "../shared/contracts"
import type { RoomState } from "../actor/src/roomTypes"

type Speak = Extract<ServerMessage, { type: "speak" }>
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const request: CreateRoomRequest = { topicId: "swe-retries", category: "software-engineering", format: "socratic", difficulty: "intermediate", participation: "participate", customQuestion: null, reading: null }
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, label: string, ms = 3000): Promise<T> {
    const end = Date.now() + ms
    while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await Bun.sleep(10) }
    throw new Error(`Timed out waiting for ${label}`)
}
async function harness(overrides: Partial<CreateRoomRequest> = {}, options:ServiceOptions = {}) {
    const root = mkdtempSync(join(tmpdir(), "apprentice-service-"))
    const store = createMemoryRoomStore(); const relay = createMemoryRelay()
    const service = new SeminarService(loadHackathonConfig(root), store, relay, options)
    cleanups.push(async () => { await service.stop(); rmSync(root, { recursive: true, force: true }) })
    const messages: ServerMessage[] = []
    const socket: RoomSocket = { send(data) { messages.push(JSON.parse(data) as ServerMessage) }, close() {} }
    await service.start()
    const room = await service.createRoom({ ...request, ...overrides })
    await service.connect(room.roomId, room.roomToken, socket)
    const handle = (message: ClientMessage) => service.handle(room.roomId, message)
    const snapshot = () => store.getSnapshot(room.roomId)
    const speaks = () => messages.filter((m): m is Speak => m.type === "speak")
    const nextSpeak = async (index: number, speaker?: Speak["speakerId"]) => {
        const turns = await until(speaks, values => values.length > index, `speech ${index}`)
        const next = turns[index]!
        if (speaker) expect(next.speakerId).toBe(speaker)
        return next
    }
    const finish = async (speech: Speak) => {
        for (let i = 0; i < speech.segments.length; i++) await handle({ type: "playback.segment", utteranceId: speech.utteranceId, segmentIndex: i, event: "ended" })
        await handle({ type: "playback.finished", utteranceId: speech.utteranceId, outcome: "completed", error: null })
    }
    const hello = () => handle({ type: "hello", clientId: "test-browser", resume: false })
    return { service, store, relay, socket, messages, room, handle, snapshot, speaks, nextSpeak, finish, hello }
}

describe("SeminarService delivery-driven flow", () => {
    test("separate workers poll active rooms without receiving a browser hello", async () => {
        const root = mkdtempSync(join(tmpdir(), "apprentice-workers-"))
        const store = createMemoryRoomStore(); const relay = createMemoryRelay(); const config = loadHackathonConfig(root)
        const coordinator = new SeminarService(config, store, relay, { role: "coordinator" })
        const workers = (["facilitator", "maya", "theo", "evidence"] as const).map(role => new SeminarService(config, store, relay, { role }))
        cleanups.push(async () => { await Promise.all([coordinator, ...workers].map(service => service.stop())); rmSync(root, { recursive: true, force: true }) })
        const cadences = new Map(workers.map(worker => [worker, [] as ("active"|"idle"|"paused")[]]))
        for (const worker of workers) {
            const original = worker.pumps.setCadenceAll
            worker.pumps.setCadenceAll = cadence => { cadences.get(worker)!.push(cadence); original(cadence) }
        }
        await Promise.all([coordinator, ...workers].map(service => service.start()))
        expect(workers.every(worker => cadences.get(worker)?.at(-1) === "idle")).toBe(true)
        const room = await coordinator.createRoom(request); const messages:ServerMessage[] = []
        await coordinator.connect(room.roomId, room.roomToken, { send(data) { messages.push(JSON.parse(data) as ServerMessage) }, close() {} })
        await coordinator.handle(room.roomId, { type: "hello", clientId: "distributed-browser", resume: false })
        const first = await until(() => messages.find((message):message is Speak => message.type === "speak"), Boolean, "distributed opening")
        expect(first?.speakerId).toBe("facilitator")
        await until(() => workers.every(worker => cadences.get(worker)?.at(-1) === "active"), Boolean, "active worker cadence")
        const state = await store.getSnapshot(room.roomId)
        expect(state.trace.some(entry => entry.kind === "session.started" && entry.to === "facilitator" && entry.direction === "in")).toBe(true)
        expect(state.trace.some(entry => entry.kind === "floor.requested" && entry.to === "bridge" && entry.direction === "in")).toBe(true)
        // Repeated actor/trace updates must not keep rescheduling the next poll.
        expect(workers.every(worker => cadences.get(worker)?.filter(cadence => cadence === "active").length === 1)).toBe(true)
        await coordinator.handle(room.roomId, { type: "session.pause" })
        await until(() => workers.every(worker => cadences.get(worker)?.at(-1) === "idle"), Boolean, "idle worker cadence")
        expect(workers.every(worker => !cadences.get(worker)?.includes("paused"))).toBe(true)
    })

    test("an uncontested proposal gets its floor before the bridge acknowledges delivery", async () => {
        const h = await harness(); const mark = h.store.markEventProcessed; let floorWhenAcknowledged = false
        h.store.markEventProcessed = async (roomId, consumer, eventId) => {
            if (consumer === "bridge" && eventId.startsWith("proposal-event-")) floorWhenAcknowledged = !!(await h.snapshot()).floor
            return mark(roomId, consumer, eventId)
        }
        await h.hello(); await h.nextSpeak(0)
        await until(() => floorWhenAcknowledged, Boolean, "immediate uncontested grant")
        expect(floorWhenAcknowledged).toBe(true)
    })

    test("approved speech warms once and interruption cancels its preparation", async () => {
        const prepared:{speakerId:Speak["speakerId"];segments:string[];signal:AbortSignal}[] = []
        const h = await harness({}, { prepareSpeech(speakerId, segments, signal) { prepared.push({ speakerId, segments, signal }) } })
        await h.hello(); const speech = await h.nextSpeak(0)
        expect(prepared).toHaveLength(1)
        expect(prepared[0]?.speakerId).toBe(speech.speakerId)
        expect(prepared[0]?.segments).toEqual(speech.segments)
        expect(prepared[0]?.signal.aborted).toBe(false)
        await h.handle({ type: "human.jumpIn", source: "button" })
        expect(prepared[0]?.signal.aborted).toBe(true)
        expect((await h.snapshot()).floor).toBeNull()
    })

    test("next-peer reasoning waits for completed delivery and sees no unheard suffix", async () => {
        const h = await harness(); const original = h.service.reasoner.propose
        const heardInputs:string[][] = []
        h.service.reasoner.propose = async (context, signal) => { heardInputs.push(context.transcript.map(item => item.heardText)); return original(context, signal) }
        await h.hello(); const speech = await h.nextSpeak(0)
        expect(speech.segments.length).toBeGreaterThan(1)
        await h.handle({ type: "playback.segment", utteranceId: speech.utteranceId, segmentIndex: 0, event: "ended" })
        await Bun.sleep(80)
        expect(heardInputs).toEqual([[]])
        await h.handle({ type: "human.jumpIn", source: "button" })
        await h.handle({ type: "human.pass" })
        await h.nextSpeak(1)
        expect(heardInputs.slice(1).every(transcript => transcript.includes(speech.segments[0]!) && !transcript.some(text => text.includes(speech.segments[1]!)))).toBe(true)
    })

    test("reasoning board context omits runtime timestamps and transport references", async () => {
        const h = await harness(); const original = h.service.reasoner.propose
        let peerBoard:unknown = null
        h.service.reasoner.propose = async (context, signal) => {
            const result = await original(context, signal)
            if (context.agentId === "facilitator") result.draft.boardUpdate = { kind: "question", text: "What does a timeout establish?", relation: null, targetCardId: null, attributeToHumanContributionId: null }
            else peerBoard = context.board
            return result
        }
        await h.hello(); await h.finish(await h.nextSpeak(0)); await h.nextSpeak(1)
        const stored = (await h.snapshot()).board[0]!
        expect(stored.createdAt).toBeGreaterThan(0)
        expect(stored.supportingContributionIds.length).toBeGreaterThan(0)
        expect(peerBoard).toEqual([{ id: stored.id, kind: stored.kind, text: stored.text, authorId: stored.authorId, status: stored.status, relations: stored.relations }])
    })

    test("facilitator → peer → peer → human invitation → human text → peer is caused by delivered Relay envelopes", async () => {
        const h = await harness(); await h.hello()
        for (const [i, id] of ["facilitator", "maya", "theo", "facilitator"].entries()) {
            const speech = await h.nextSpeak(i, id as Speak["speakerId"])
            const before = await h.snapshot()
            expect(before.floor?.utteranceId).toBe(speech.utteranceId)
            expect(before.contributions.at(-1)?.heardText).toBe("")
            expect(before.trace.some(t => t.kind === "floor.requested" && t.direction === "in" && t.to === "bridge" && t.relayMessageId)).toBe(true)
            await h.finish(speech)
        }
        const invited = await h.snapshot()
        expect(invited.turn.awaitingHuman).toBe(true); expect(invited.floor).toBeNull(); expect(invited.budget.aiTurnsUsed).toBe(4)
        await Bun.sleep(80); expect(h.speaks()).toHaveLength(4)
        const thought = "The same operation key must be persisted before either attempt commits."
        await h.handle({ type: "human.contribution", eventId: "human-one", text: thought, inputMode: "text", replyToContributionId: invited.contributions.at(-1)!.id, addressedTo: "maya" })
        const response = await h.nextSpeak(4, "maya")
        expect(response.segments.join(" ")).toContain("The same operation key must be persisted")
        const state = await h.snapshot(); const human = state.contributions.find(c => c.eventId === "human-one")!
        expect(state.contributions.at(-1)?.replyToContributionId).toBe(human.id)
        expect(human.relayMessageId).toBeTruthy()
        const history = await h.relay.history(state.config!.relayChannel, null, 100)
        expect(history.map(m => (m.metadata as RelayEnvelope).kind)).toEqual(["session.started", "contribution.heard", "contribution.heard", "contribution.heard", "contribution.heard", "human.contributed"])
        expect(state.processedEventKeys).toContain("bridge:kickoff")
        expect(h.service.providers().relay.mode).toBe("fixture")
    })

    test("interrupt preserves only heard audio; late playback acknowledgements cannot advance the room", async () => {
        const h = await harness(); await h.hello(); const speech = await h.nextSpeak(0, "facilitator")
        await h.handle({ type: "playback.segment", utteranceId: speech.utteranceId, segmentIndex: 0, event: "ended" })
        await h.handle({ type: "human.jumpIn", source: "button" })
        const interrupted = await h.snapshot()
        expect(interrupted.floor).toBeNull(); expect(interrupted.turn.awaitingHuman).toBe(true)
        expect(interrupted.contributions.at(-1)?.status).toBe("interrupted")
        expect(interrupted.contributions.at(-1)?.heardText).toBe(speech.segments[0]!)
        for (let i = 0; i < speech.segments.length; i++) await h.handle({ type: "playback.segment", utteranceId: speech.utteranceId, segmentIndex: i, event: "ended" })
        await h.handle({ type: "playback.finished", utteranceId: speech.utteranceId, outcome: "completed", error: null })
        const after = await h.snapshot()
        expect(after.generationEpoch).toBe(interrupted.generationEpoch); expect(after.version).toBe(interrupted.version)
        expect(after.budget.aiTurnsUsed).toBe(0); expect(after.floor).toBeNull()
        await Bun.sleep(100); expect(h.speaks()).toHaveLength(1)
    })

    test("all three payment experiments travel through the evidence worker and preserve the human floor", async () => {
        const h = await harness(); await h.hello(); await h.finish(await h.nextSpeak(0))
        await h.handle({ type: "human.jumpIn", source: "button" })
        let calls = 0; const originalRun = h.service.tools.run
        h.service.tools.run = input => { calls++; return originalRun(input) }
        for (const caseId of ["no-key-retry", "stable-key-retry", "new-key-retry"]) await h.handle({ type: "evidence.request", toolId: "payment-retry-sim", caseId })
        const state = await until(h.snapshot, s => s.evidence.filter(e => e.status === "returned").length === 3, "three evidence deliveries")
        expect(state.evidence.map(e => e.result?.metrics.charges)).toEqual([2, 1, 2])
        expect(calls).toBe(3); expect(state.turn.awaitingHuman).toBe(true); expect(state.floor).toBeNull()
        expect(state.board.filter(c => c.kind === "evidence")).toHaveLength(3)
        expect(state.evidence.every(e => e.resultRelayMessageId)).toBe(true)
        expect(state.trace.some(t => t.kind === "evidence.requested" && t.direction === "in" && t.to === "evidence")).toBe(true)
        expect(state.trace.some(t => t.kind === "evidence.returned" && t.direction === "in" && t.to === "bridge")).toBe(true)
        await h.handle({ type: "human.pass" }); const discussion = await h.nextSpeak(1)
        expect(discussion.segments.join(" ")).toContain("two attempts produced 2 charges")
    })

    test("pause revokes speech, resume recovers, and reflection cites actual human words", async () => {
        const h = await harness(); await h.hello(); const first = await h.nextSpeak(0)
        await h.handle({ type: "session.pause" }); expect((await h.snapshot()).phase).toBe("paused")
        await h.finish(first); expect((await h.snapshot()).budget.aiTurnsUsed).toBe(0)
        await h.handle({ type: "session.resume" }); await h.nextSpeak(1, "facilitator")
        const words = "I think a timeout leaves the outcome unknown."
        await h.handle({ type: "human.contribution", eventId: "human-reflect", text: words, inputMode: "text", replyToContributionId: null, addressedTo: "group" })
        const humanId = (await h.snapshot()).contributions.find(c => c.eventId === "human-reflect")!.id
        await h.handle({ type: "session.end" })
        const ended = await until(h.snapshot, s => s.reflection !== null, "reflection")
        expect(ended.phase).toBe("ended"); expect(ended.floor).toBeNull()
        expect(ended.reflection?.initialPosition).toEqual({ text: words, contributionIds: [humanId] })
        expect(ended.reflection?.revisedPosition).toBeNull()
        expect(ended.reflection?.nextQuestion).toContain("concurrently")
    })

    test("cancelled reasoning cannot speak after the human takes the floor", async () => {
        const h = await harness(); const original = h.service.reasoner.propose
        let started = false; let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        h.service.reasoner.propose = async (ctx, signal) => { started = true; await gate; return original(ctx, signal) }
        await h.hello(); await until(() => started, Boolean, "reasoning to start")
        await h.handle({ type: "human.jumpIn", source: "voice-onset" }); release()
        await Bun.sleep(250)
        expect(h.speaks()).toHaveLength(0); expect((await h.snapshot()).turn.awaitingHuman).toBe(true)
        expect((await h.snapshot()).pendingProposals).toHaveLength(0)
    })

    test("disconnect during an actor floor grant revokes the lease without emitting speech", async () => {
        const h = await harness(); const original = h.store.claimFloor
        let disconnected = false
        h.store.claimFloor = async (id, input) => {
            const result = await original(id, input)
            if (result.ok) { await h.service.disconnect(id, h.socket); disconnected = true }
            return result
        }
        await h.hello()
        await until(() => disconnected, Boolean, "disconnect during floor grant")
        await until(h.snapshot, s => s.pauseReason === "no-listener", "no-listener pause")
        expect((await h.snapshot()).floor).toBeNull()
        expect(h.speaks()).toHaveLength(0)
        expect(h.service.sockets.has(h.room.roomId)).toBe(false)
    })

    test("all-yield returns a usable human turn instead of leaving an idle room", async () => {
        const h = await harness(); const original = h.service.reasoner.propose
        h.service.reasoner.propose = async (ctx, signal) => { const result = await original(ctx, signal); return { ...result, draft: { ...result.draft, action: "yield", text: "" } } }
        await h.hello()
        const state = await until(h.snapshot, s => s.turn.awaitingHuman, "yield handoff")
        expect(state.phase).toBe("discussion"); expect(state.floor).toBeNull(); expect(state.budget.generationCalls).toBe(1)
        expect(h.messages.some(m => m.type === "notice" && m.text.includes("table is yours"))).toBe(true)
        expect(h.speaks()).toHaveLength(0)
    })

    test("one fast yield does not steal the floor from a slower eligible peer", async () => {
        const h = await harness(); await h.hello(); await h.finish(await h.nextSpeak(0))
        await h.handle({ type: "human.jumpIn", source: "button" })
        await h.handle({ type: "evidence.request", toolId: "payment-retry-sim", caseId: "stable-key-retry" })
        await until(h.snapshot, s => s.evidence.some(e => e.status === "returned"), "evidence")
        const original = h.service.reasoner.propose
        h.service.reasoner.propose = async (ctx, signal) => {
            const result = await original(ctx, signal)
            if (ctx.agentId === "maya") return { ...result, draft: { ...result.draft, action: "yield", text: "" } }
            await Bun.sleep(300); return result
        }
        await h.handle({ type: "human.pass" })
        const speech = await h.nextSpeak(1, "theo")
        expect(speech.segments.join(" ")).toContain("1 charge")
        expect((await h.snapshot()).turn.awaitingHuman).toBe(false)
    })

    test("Participate never times out the human; Observe can continue automatically", async () => {
        for (const participation of ["participate", "observe"] as const) {
            const h = await harness({ participation })
            await h.handle({ type: "human.jumpIn", source: "button" })
            const original = h.store.getSnapshot
            h.store.getSnapshot = async id => {
                const state = await original(id)
                if (state.turn.awaitingHuman) state.turn.invitedAt = Date.now() - 90_000
                return state
            }
            await (h.service as unknown as { tick(): Promise<void> }).tick()
            expect((await original(h.room.roomId)).turn.awaitingHuman).toBe(participation === "participate")
        }
    })

    test("every topic remains a Socratic seminar, including older format requests", async () => {
        for (const input of [
            { topicId: "debate-ai-tools", category: "software-engineering", format: "debate" },
            { topicId: "math-multiplication", category: "mathematics", format: "socratic" },
            { topicId: "knowledge-memory", category: "general-knowledge", format: "exploration" },
            { topicId: "custom", category: "custom", format: "socratic", customQuestion: "What makes an explanation useful?" },
        ] as Partial<CreateRoomRequest>[]) {
            const h = await harness(input); await h.hello(); const first = await h.nextSpeak(0, "facilitator")
            const config = (await h.snapshot()).config!
            expect(config.topicId).toBe(input.topicId!); expect(config.format).toBe("socratic")
            expect(first.segments.join(" ")).toContain(config.openingQuestion)
        }
    })

    test("theme change preserves the heard prefix, rejects old callbacks, and continues with the new names", async () => {
        const h = await harness({ theme: "halloween" }); await h.hello()
        await h.finish(await h.nextSpeak(0, "facilitator"))
        const oldSpeech = await h.nextSpeak(1, "maya")
        expect(oldSpeech.segments.join(" ")).toContain("Wednesday Addams")
        expect(oldSpeech.segments.length).toBeGreaterThan(1)
        await h.handle({ type: "playback.segment", utteranceId: oldSpeech.utteranceId, segmentIndex: 0, event: "ended" })
        const before = await h.snapshot()
        await h.handle({ type: "session.theme", theme: "classroom" })
        const changed = await h.snapshot()
        expect(changed.config?.theme).toBe("classroom")
        expect(changed.generationEpoch).toBeGreaterThan(before.generationEpoch)
        expect(changed.phase).toBe("discussion"); expect(changed.turn.awaitingHuman).toBe(false)
        const interrupted = changed.contributions.find(c => c.id === oldSpeech.contributionId)!
        expect(interrupted.status).toBe("interrupted"); expect(interrupted.heardText).toBe(oldSpeech.segments[0]!)
        expect(interrupted.heardText).not.toContain("Wednesday")
        const currentSpeech = await h.nextSpeak(2, "theo")
        expect(currentSpeech.segments.join(" ")).toContain("Maya")
        expect(currentSpeech.segments.join(" ")).not.toContain("Dracula")
        const current = await h.snapshot()
        await h.finish(oldSpeech)
        const staleIgnored = await h.snapshot()
        expect(staleIgnored.floor?.utteranceId).toBe(currentSpeech.utteranceId)
        expect(staleIgnored.version).toBe(current.version)
        expect(staleIgnored.budget.aiTurnsUsed).toBe(1)
        expect(staleIgnored.contributions.find(c => c.id === oldSpeech.contributionId)?.heardText).toBe(oldSpeech.segments[0]!)
        const history = await h.relay.history(changed.config!.relayChannel, null, 100)
        const heardPrefix = history.find(m => (m.metadata as RelayEnvelope).eventId === `heard-${oldSpeech.contributionId}-${changed.sessionId}`)!
        expect((heardPrefix.metadata as Extract<RelayEnvelope, { kind: "contribution.heard" }>).payload.heardText).toBe(oldSpeech.segments[0]!)
        expect(history.some(m => (m.metadata as RelayEnvelope).kind === "floor.opened" && (m.metadata as RelayEnvelope).generationEpoch === changed.generationEpoch)).toBe(true)
        await h.handle({ type: "session.theme", theme: "halloween" })
        const switchedBack = await h.nextSpeak(3, "theo")
        expect(switchedBack.segments.join(" ")).toContain("Count Dracula")
    })

    test("theme changes preserve the human floor and do not resume a paused room", async () => {
        const h = await harness({ theme: "halloween" }); await h.hello(); await h.nextSpeak(0)
        await h.handle({ type: "human.jumpIn", source: "button" })
        const before = await h.snapshot()
        await h.handle({ type: "session.theme", theme: "classroom" })
        const humanTurn = await h.snapshot()
        expect(humanTurn.turn.awaitingHuman).toBe(true); expect(humanTurn.turn.invitedAt).toBe(before.turn.invitedAt)
        expect(humanTurn.phase).toBe("discussion"); expect(humanTurn.floor).toBeNull()
        await Bun.sleep(160); expect(h.speaks()).toHaveLength(1)
        await h.handle({ type: "session.pause" })
        const paused = await h.snapshot()
        await h.handle({ type: "session.theme", theme: "halloween" })
        const changed = await h.snapshot()
        expect(changed.phase).toBe("paused"); expect(changed.pauseReason).toBe(paused.pauseReason)
        expect(changed.config?.theme).toBe("halloween"); expect(changed.floor).toBeNull()
        await Bun.sleep(160); expect(h.speaks()).toHaveLength(1)
        const history = await h.relay.history(changed.config!.relayChannel, null, 100)
        expect(history.some(m => (m.metadata as RelayEnvelope).kind === "floor.opened")).toBe(false)
    })

    test("changing theme while reflection is generated does not cancel session completion", async () => {
        const h = await harness({ theme: "halloween" }); const original = h.service.reasoner.reflect
        let reflectionSignal: AbortSignal | null = null; let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        h.service.reasoner.reflect = async (input, signal) => { reflectionSignal = signal; await gate; return original(input, signal) }
        await h.handle({ type: "session.end" })
        const signal = await until(() => reflectionSignal, value => value !== null, "reflection to start")
        await h.handle({ type: "session.theme", theme: "classroom" })
        expect(signal?.aborted).toBe(false); expect((await h.snapshot()).phase).toBe("reflection")
        release()
        const ended = await until(h.snapshot, s => s.phase === "ended", "reflection completion")
        expect(ended.config?.theme).toBe("classroom"); expect(ended.reflection).not.toBeNull()
    })
})

describe("durable Relay outbox", () => {
    test("retry after network success but durable commit failure reuses the persisted envelope and Relay ID", async () => {
        const h = await harness()
        const state: RoomState = await h.snapshot()
        const envelope: RelayEnvelope = { v: 1, eventId: "crash-window", roomId: h.room.roomId, sessionId: h.room.sessionId, actorId: "bridge", kind: "session.paused", replyTo: null, roomVersion: state.version, generationEpoch: state.generationEpoch, utteranceId: null, text: "Original durable payload", payload: { reason: "test" } }
        const original = h.store.markOutboundSent; let failOnce = true
        h.store.markOutboundSent = async (id, event) => { if (failOnce) { failOnce = false; throw new Error("simulated commit failure") }; return original(id, event) }
        const outbox = createOutbox(h.relay, h.store, createDeliveryPumpGroup())
        const input = { roomId: h.room.roomId, sender: "bridge" as const, target: { type: "channel" as const, channel: state.config!.relayChannel }, text: envelope.text, envelope }
        await expect(outbox.send(input)).rejects.toThrow("simulated commit failure")
        expect((await h.snapshot()).pendingOutbound).toHaveLength(1)
        const retry = await outbox.send({ ...input, text: "Changed attempt", envelope: { ...envelope, text: "Changed attempt" } })
        expect(retry.replayed).toBe(true)
        const history = await h.relay.history(state.config!.relayChannel, null, 100)
        expect(history).toHaveLength(1); expect(history[0]!.text).toBe("Original durable payload")
        expect(history[0]!.messageId).toBe(retry.messageId)
        expect((await h.snapshot()).pendingOutbound).toHaveLength(0)
        expect((await outbox.send(input)).messageId).toBe(retry.messageId)
    })
})
