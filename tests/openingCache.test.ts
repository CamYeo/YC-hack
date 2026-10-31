import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withOpeningCache } from "../server/agents/openingCache"
import { createReasoner } from "../server/agents/reasoner"
import type { AgentContext, Reasoner } from "../server/agents/types"
import type { ProposalDraft } from "../shared/contracts"
import { createTopicRegistry } from "../topics"

const roots:string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function context(): AgentContext {
    const storedTopic = createTopicRegistry().get("swe-retries")
    if (!storedTopic) throw new Error("Missing test topic")
    const topic = structuredClone(storedTopic)
    const config:AgentContext["config"] = { topicId: topic.id, topicTitle: topic.title, category: topic.category, format: "socratic", theme: "classroom", difficulty: "intermediate", participation: "participate", openingQuestion: topic.openingQuestion, customQuestion: null, reading: null, sessionMinutes: 15, maxAiTurns: 40, maxGenerationCalls: 100, aiTurnsBeforeInvite: 2, relayChannel: "sem-room-one" }
    const hint:AgentContext["hint"] = { mode: "open", preferredSpeakers: ["facilitator"], requiredAddressee: null, debateStage: null, reason: "Opening question" }
    return { agentId: "facilitator", roomId: "room-one", sessionId: "session-one", config, topic, transcript: [], board: [], evidence: [], hint, privateNotes: [], roomVersion: 1, generationEpoch: 1,
        trigger: { v: 1, eventId: "event-one", roomId: "room-one", sessionId: "session-one", actorId: "bridge", kind: "session.started", replyTo: null, roomVersion: 1, generationEpoch: 1, utteranceId: null, text: "The seminar begins.", payload: { topicId: topic.id, topicTitle: topic.title, format: config.format, participation: config.participation, difficulty: config.difficulty, openingQuestion: config.openingQuestion, hint } } }
}
const opening = ():ProposalDraft => ({ action: "contribute", replyToContributionId: null, addressedTo: "maya", text: "A checkout times out. Maya, would you retry the payment?", sourceIds: [], evidenceRequest: null, boardUpdate: null, privateNote: "Frame the question without answering it." })
function exchangeContext(seat:"maya"|"theo", prefix = "old"):AgentContext {
    const value = context(); value.agentId = seat; value.roomId = `${prefix}-room`; value.sessionId = `${prefix}-session`; value.config.relayChannel = `${prefix}-channel`
    value.transcript = [{ id: `${prefix}-facilitator`, speakerId: "facilitator", addressedTo: "maya", replyToContributionId: null, heardText: opening().text, status: "heard", sourceIds: [] }]
    value.board = [{ id: `${prefix}-question`, kind: "question", text: "When is a retry safe?", authorId: "facilitator", status: "unresolved", relations: [] }]
    if (seat === "theo") {
        value.transcript.push({ id: `${prefix}-maya`, speakerId: "maya", addressedTo: "theo", replyToContributionId: `${prefix}-facilitator`, heardText: "I would retry a temporary failure. Theo, what could make that unsafe?", status: "heard", sourceIds: [] })
        value.board.push({ id: `${prefix}-claim`, kind: "claim", text: "A retry may complete the purchase.", authorId: "maya", status: "proposed", relations: [{ type: "answers", targetCardId: `${prefix}-question` }] })
    }
    const last = value.transcript.at(-1)!
    value.roomVersion = value.transcript.length + 1
    value.hint = { mode: "peer-exchange", preferredSpeakers: [seat], requiredAddressee: null, debateStage: null, reason: "Respond to the other participant's reasoning" }
    value.trigger = { v: 1, eventId: `${prefix}-event`, roomId: value.roomId, sessionId: value.sessionId, actorId: last.speakerId as "facilitator"|"maya", kind: "contribution.heard", replyTo: last.id, roomVersion: value.roomVersion, generationEpoch: 1, utteranceId: null, text: last.heardText, payload: { contributionId: last.id, speakerId: last.speakerId, addressedTo: last.addressedTo, replyToContributionId: last.replyToContributionId, heardText: last.heardText, interrupted: false, sourceIds: last.sourceIds, hint: value.hint } }
    return value
}
async function harness() {
    const directory = await mkdtemp(join(tmpdir(), "apprentice-opening-cache-")); roots.push(directory)
    let calls = 0
    const underlying:Reasoner = { ...createReasoner(null), mode: "openai", label: "OpenAI test-model", async propose(ctx) {
        calls++; const draft = opening()
        if (ctx.transcript.length) {
            draft.replyToContributionId = ctx.transcript.at(-1)!.id
            draft.text = ctx.agentId === "maya" ? "I would retry a temporary failure. Theo, what could make that unsafe?" : "The timeout does not prove failure. Maya, how would you avoid a duplicate charge?"
            draft.addressedTo = ctx.agentId === "maya" ? "theo" : "maya"
            draft.boardUpdate = { kind: "question", text: "What observation would distinguish the two outcomes?", relation: "answers", targetCardId: ctx.board[0]?.id ?? null, attributeToHumanContributionId: null }
        }
        return { draft, latencyMs: 37 }
    } }
    const wrap = (model = "test-model", reasoningEffort:string|null = "minimal") => withOpeningCache(underlying, { directory, model, reasoningEffort })
    return { directory, underlying, wrap, calls: () => calls, signal: new AbortController().signal }
}

describe("opt-in untouched SWE opening exchange cache", () => {
    test("persists a validated generated opening across new room IDs and discloses the hit", async () => {
        const h = await harness(); const first = await h.wrap().propose(context(), h.signal)
        expect(first.cacheHit).toBe(false); expect(h.calls()).toBe(1)
        const next = context(); next.roomId = "room-two"; next.sessionId = "session-two"; next.config.relayChannel = "sem-room-two"
        next.trigger.roomId = next.roomId; next.trigger.sessionId = next.sessionId; next.trigger.eventId = "event-two"
        const result = await h.wrap().propose(next, h.signal)
        expect(result.cacheHit).toBe(true); expect(result.draft).toEqual(first.draft); expect(h.calls()).toBe(1)
        expect(h.wrap().label).toContain("opening exchange cache enabled, replies live")
        const files = await readdir(h.directory); expect(files).toHaveLength(1)
        const path = join(h.directory, files[0]!)
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        const saved = await readFile(path, "utf8")
        expect(saved).not.toContain("room-one"); expect(saved).not.toContain("session-one"); expect(saved).not.toContain("sem-room-one")
    })

    test("first peer exchanges match actual heard history and rebind reply and board IDs", async () => {
        const h = await harness()
        for (const seat of ["maya", "theo"] as const) {
            const oldRoom = exchangeContext(seat, "old"); const first = await h.wrap().propose(oldRoom, h.signal)
            expect(first.cacheHit).toBe(false)
            const fresh = exchangeContext(seat, "fresh"); const hit = await h.wrap().propose(fresh, h.signal)
            expect(hit.cacheHit).toBe(true); expect(hit.draft.text).toBe(first.draft.text)
            expect(hit.draft.replyToContributionId).toBe(fresh.transcript.at(-1)!.id)
            expect(hit.draft.boardUpdate?.targetCardId).toBe("fresh-question")
            expect(hit.draft.replyToContributionId).not.toBe(oldRoom.transcript.at(-1)!.id)
        }
        expect(h.calls()).toBe(2)
        for (const file of await readdir(h.directory)) {
            const saved = await readFile(join(h.directory, file), "utf8")
            expect(saved).not.toContain("old-facilitator"); expect(saved).not.toContain("old-maya"); expect(saved).not.toContain("old-question")
        }
    })

    test("changed heard wording, board meaning or relations require fresh generation", async () => {
        const h = await harness(); await h.wrap().propose(exchangeContext("theo"), h.signal)
        const variants:((value:AgentContext)=>void)[] = [
            value => { const last = value.transcript.at(-1)!; last.heardText = "I would never retry without first checking the server."; if (value.trigger.kind === "contribution.heard") { value.trigger.payload.heardText = last.heardText; value.trigger.text = last.heardText } },
            value => { value.board[0]!.text = "Was the first charge committed?" },
            value => { value.board[1]!.relations[0]!.type = "challenges" },
            value => { value.config.theme = "halloween" },
        ]
        for (const mutate of variants) { const value = exchangeContext("theo", "fresh"); mutate(value); expect((await h.wrap().propose(value, h.signal)).cacheHit).toBe(false) }
        expect(h.calls()).toBe(5)
    })

    test("interrupted, resumed, human, evidence and later triggers cannot reuse the exchange", async () => {
        const h = await harness(); await h.wrap().propose(exchangeContext("theo"), h.signal)
        const variants:((value:AgentContext)=>void)[] = [
            value => { value.transcript[0]!.status = "interrupted" },
            value => { value.generationEpoch = 2; value.trigger.generationEpoch = 2 },
            value => { value.transcript[1]!.speakerId = "human"; value.transcript[1]!.status = "human" },
            value => { value.privateNotes.push("Previous turn") },
            value => { value.evidence.push({ id: "e1", requestedBy: "human", toolId: "payment-retry-sim", caseId: "stable-key-retry", status: "pending", result: null, error: null }) },
            value => { value.trigger = { ...value.trigger, kind: "floor.opened", actorId: "bridge", payload: { reason: "human-pass", hint: value.hint } } },
            value => { value.board[0]!.authorId = "human" },
            value => { value.board[1]!.relations[0]!.targetCardId = "unmapped-card" },
            value => { value.transcript[1]!.replyToContributionId = "unmapped-contribution" },
        ]
        for (const mutate of variants) { const value = exchangeContext("theo", "fresh"); mutate(value); expect((await h.wrap().propose(value, h.signal)).cacheHit).not.toBe(true) }
        expect(h.calls()).toBe(variants.length + 1); expect(await readdir(h.directory)).toHaveLength(1)
    })

    test("theme, difficulty, source, hint, model and effort changes cannot reuse another opening", async () => {
        const h = await harness(); await h.wrap().propose(context(), h.signal)
        const variants:((value:AgentContext)=>void)[] = [
            value => { value.config.theme = "halloween" },
            value => { value.config.difficulty = "advanced" },
            value => { value.topic.sources[0]!.summary += " Updated source interpretation." },
            value => { value.hint.reason = "A different learning objective" },
            value => { value.config.participation = "observe" },
        ]
        for (const mutate of variants) { const value = context(); mutate(value); expect((await h.wrap().propose(value, h.signal)).cacheHit).toBe(false) }
        expect((await h.wrap("other-model").propose(context(), h.signal)).cacheHit).toBe(false)
        expect((await h.wrap("test-model", "low").propose(context(), h.signal)).cacheHit).toBe(false)
        expect(h.calls()).toBe(8)
    })

    test("human context, other topics, peers, readings and subsequent turns always bypass", async () => {
        const h = await harness(); await h.wrap().propose(context(), h.signal)
        const variants:((value:AgentContext)=>void)[] = [
            value => { value.transcript.push({ id: "human-private", speakerId: "human", addressedTo: "group", replyToContributionId: null, heardText: "A private human opinion.", status: "human", sourceIds: [] }) },
            value => { value.config.topicId = "knowledge-memory"; value.topic.id = "knowledge-memory" },
            value => { value.agentId = "maya" },
            value => { value.config.reading = "A private reading." },
            value => { value.config.customQuestion = "A private question?" },
            value => { value.privateNotes.push("Prior private reasoning") },
            value => { value.hint.mode = "peer-exchange" },
            value => { value.board.push({ id: "b1", kind: "claim", text: "Human board note", authorId: "human", status: "proposed", relations: [] }) },
            value => { value.evidence.push({ id: "ev1", requestedBy: "human", toolId: "payment-retry-sim", caseId: "stable-key-retry", status: "pending", result: null, error: null }) },
        ]
        for (const mutate of variants) { const value = context(); mutate(value); expect((await h.wrap().propose(value, h.signal)).cacheHit).not.toBe(true) }
        expect(h.calls()).toBe(variants.length + 1)
        expect(await readdir(h.directory)).toHaveLength(1)
    })

    test("invalid cached references and expired entries are regenerated", async () => {
        const h = await harness(); await h.wrap().propose(context(), h.signal)
        const path = join(h.directory, (await readdir(h.directory))[0]!)
        const value = JSON.parse(await readFile(path, "utf8")) as { createdAt:number; draft:ProposalDraft }
        value.draft.replyToContributionId = "old-room-human"
        await writeFile(path, JSON.stringify(value))
        expect((await h.wrap().propose(context(), h.signal)).cacheHit).toBe(false)
        value.draft = opening(); value.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000
        await writeFile(path, JSON.stringify(value))
        expect((await h.wrap().propose(context(), h.signal)).cacheHit).toBe(false)
        expect(h.calls()).toBe(3)
    })

    test("cancelled generation neither returns nor writes an opening", async () => {
        const h = await harness(); const abort = new AbortController()
        h.underlying.propose = async () => { abort.abort(); return { draft: opening(), latencyMs: 1 } }
        await expect(h.wrap().propose(context(), abort.signal)).rejects.toThrow()
        expect(await readdir(h.directory)).toHaveLength(0)
    })

    test("disk cache remains bounded and fixtures are never presented as cached OpenAI", async () => {
        const h = await harness()
        for (let index = 0; index < 14; index++) await h.wrap(`test-model-${index}`).propose(context(), h.signal)
        expect(await readdir(h.directory)).toHaveLength(12)
        const fixture = createReasoner(null)
        expect(withOpeningCache(fixture, { directory: h.directory, model: "unused", reasoningEffort: null })).toBe(fixture)
    })
})
