import { describe, expect, test } from "bun:test"
import { checkedReflection, createReasoner, validateDraft } from "../server/agents/reasoner"
import { createTopicRegistry } from "../topics"
import type { AgentContext, ReflectionInput } from "../server/agents/types"
import type { ProposalDraft, ReflectionDraft } from "../shared/contracts"
import type { RoomConfig } from "../actor/src/roomTypes"

const config: RoomConfig = {
    topicId: "swe-retries", topicTitle: "Retries", category: "software-engineering", format: "socratic",
    difficulty: "intermediate", participation: "participate", openingQuestion: "Should we retry?", customQuestion: null,
    reading: null, sessionMinutes: 15, maxAiTurns: 40, maxGenerationCalls: 120, aiTurnsBeforeInvite: 2, relayChannel: "sem-test",
}
function context(): AgentContext {
    const topic = createTopicRegistry().get("swe-retries")
    if (!topic) throw new Error("Missing test topic")
    const hint: AgentContext["hint"] = { mode: "peer-exchange", preferredSpeakers: ["theo"], requiredAddressee: null, debateStage: null, reason: "Peer reply" }
    return { agentId: "theo", roomId: "r1", sessionId: "s1", config, topic,
        transcript: [{ id: "c1", speakerId: "maya", addressedTo: "theo", replyToContributionId: null, heardText: "I would retry.", status: "heard", sourceIds: [] },
            { id: "c2", speakerId: "human", addressedTo: "group", replyToContributionId: "c1", heardText: "Reuse the same idempotency key.", status: "human", sourceIds: [] }],
        board: [{ id: "b1", kind: "claim", text: "Retry", authorId: "maya", status: "proposed", relations: [] }], evidence: [], hint,
        trigger: { v: 1, eventId: "e1", roomId: "r1", sessionId: "s1", actorId: "bridge", replyTo: "c1", roomVersion: 1, generationEpoch: 1, utteranceId: null, text: "Floor open", kind: "floor.opened", payload: { reason: "peer-reply", hint } },
        privateNotes: [], roomVersion: 1, generationEpoch: 1 }
}
function draft(overrides: Partial<ProposalDraft> = {}): ProposalDraft {
    return { action: "contribute", replyToContributionId: "c1", addressedTo: "maya", text: "Could the server have committed before the timeout?", sourceIds: [], evidenceRequest: null, boardUpdate: null, privateNote: "Check ambiguity", ...overrides }
}
function must<T>(value: T | undefined | null): T { if (value === undefined || value === null) throw new Error("Missing fixture value"); return value }
function reflectionInput(): ReflectionInput {
    const ctx = context()
    return { config, topic: ctx.topic, transcript: ctx.transcript, evidence: [], board: [{ ...must(ctx.board[0]), promptedBy: null, supportingContributionIds: ["c1"] }] }
}
const emptyReflection = (): ReflectionDraft => ({ initialPosition: null, challenge: null, revisedPosition: null, usefulQuestion: null, revisedAssumption: null, unresolved: null, nextQuestion: "What changes under concurrent retries?", contributionImpact: null })

describe("proposal validation", () => {
    test("invalid sources/reply IDs and missing relation targets are removed without mutating input", () => {
        const input = draft({ sourceIds: ["fabricated", "aws-retries", "aws-retries"], replyToContributionId: "missing", boardUpdate: { kind: "claim", text: "Timeout is ambiguous", relation: "challenges", targetCardId: "missing", attributeToHumanContributionId: null } })
        const result = validateDraft(input, context())
        expect(result.sourceIds).toEqual(["aws-retries"]); expect(result.replyToContributionId).toBeNull()
        expect(result.boardUpdate?.targetCardId).toBeNull(); expect(result.boardUpdate?.relation).toBeNull()
        expect(input.sourceIds).toHaveLength(3)
    })
    test("a human card cannot be invented from an AI or superseded turn", () => {
        const input = draft({ boardUpdate: { kind: "claim", text: "The learner believes retries are safe", relation: null, targetCardId: null, attributeToHumanContributionId: "c1" } })
        expect(validateDraft(input, context()).boardUpdate).toBeNull()
        const ctx = context(); ctx.transcript[1] = { ...must(ctx.transcript[1]), status: "superseded" }
        input.boardUpdate = { ...must(input.boardUpdate), attributeToHumanContributionId: "c2" }
        expect(validateDraft(input, ctx).boardUpdate).toBeNull()
    })
    test("unheard text is never a valid reply target", () => {
        const ctx = context(); ctx.transcript[0] = { ...must(ctx.transcript[0]), status: "speaking", heardText: "" }
        expect(validateDraft(draft(), ctx).replyToContributionId).toBeNull()
    })
    test("invalid or completed tools cannot be requested and yields carry no side effects", () => {
        expect(validateDraft(draft({ action: "request_evidence", evidenceRequest: { toolId: "bad", caseId: null, question: "Run?" } }), context()).action).toBe("contribute")
        expect(validateDraft(draft({ action: "request_evidence", evidenceRequest: null }), context()).action).toBe("contribute")
        const ctx = context(); ctx.evidence = [{ id: "ev1", requestedBy: "maya", toolId: "payment-retry-sim", caseId: "stable-key-retry", status: "pending", result: null, error: null }]
        const result = validateDraft(draft({ action: "request_evidence", evidenceRequest: { toolId: "payment-retry-sim", caseId: "stable-key-retry", question: "Run?" } }), ctx)
        expect(result.evidenceRequest).toBeNull()
        const yielded = validateDraft(draft({ action: "yield", sourceIds: ["aws-retries"] }), ctx)
        expect(yielded.text).toBe(""); expect(yielded.sourceIds).toEqual([])
    })
    test("turn length and one-question constraints are enforced; required addressee wins", () => {
        expect(() => validateDraft(draft({ text: Array(61).fill("word").join(" ") }), context())).toThrow("turn limit")
        const ctx = context(); ctx.hint.requiredAddressee = "human"
        const result = validateDraft(draft({ text: "What if the response was lost? Why retry?", addressedTo: "theo" }), ctx)
        expect(result.text).toBe("What if the response was lost?"); expect(result.addressedTo).toBe("human")
        const extraQuestions = `Could the response have been lost? ${Array(61).fill("word").join(" ")}?`
        expect(validateDraft(draft({ text: extraQuestions }), ctx).text).toBe("Could the response have been lost?")
    })
})

describe("reflection attribution", () => {
    test("learner positions cannot be attributed to AI or nonexistent contributions", () => {
        const result = checkedReflection({ ...emptyReflection(), initialPosition: { text: "I learned this", contributionIds: ["c1"] }, revisedPosition: { text: "Changed", contributionIds: ["fake"] }, revisedAssumption: { text: "Revised", contributionIds: ["c1"] }, usefulQuestion: { text: "Human claim", contributionIds: ["c2"] }, challenge: { text: "AI challenge", contributionIds: ["c1"] }, unresolved: { text: "Missing", cardIds: ["fake"] } }, reflectionInput())
        expect(result.initialPosition).toBeNull(); expect(result.revisedPosition).toBeNull(); expect(result.revisedAssumption).toBeNull()
        expect(result.usefulQuestion?.contributionIds).toEqual(["c2"]); expect(result.challenge?.contributionIds).toEqual(["c1"]); expect(result.unresolved).toBeNull()
    })
    test("listener-only fixture has no fabricated learning or position; unrelated second turn is not a revision", async () => {
        const input = reflectionInput(); input.transcript = input.transcript.filter(c => c.speakerId !== "human")
        const reasoner = createReasoner(null)
        expect((await reasoner.reflect(input, new AbortController().signal)).draft.initialPosition).toBeNull()
        const withHuman = reflectionInput()
        withHuman.transcript.push({ id: "c3", speakerId: "human", status: "human", heardText: "How long should a key be stored?", replyToContributionId: "c2" })
        const result = (await reasoner.reflect(withHuman, new AbortController().signal)).draft
        expect(result.initialPosition?.text).toBe("Reuse the same idempotency key.")
        expect(result.revisedPosition).toBeNull(); expect(result.usefulQuestion?.contributionIds).toEqual(["c3"])
    })
    test("fixture response uses the actual human statement and references its ID", async () => {
        const ctx = context(); ctx.hint.mode = "respond-to-human"
        const result = await createReasoner(null).propose(ctx, new AbortController().signal)
        expect(result.draft.text).toContain("Reuse the same idempotency key")
        expect(result.draft.replyToContributionId).toBe("c2")
        expect(result.draft.privateNote).toContain("fixture")
    })
})

describe("OpenAI request contract without spending credits", () => {
    const openai = { apiKey: "test", model: "test", reasoningEffort: null, baseUrl: "https://api.openai.com/v1" } as const
    const longDraft = () => draft({ text: Array(61).fill("word").join(" ") })
    const modelResponse = (value: ProposalDraft) => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] })

    test("one oversized answer gets a shorter structured retry using the same context", async () => {
        const bodies: { instructions: string; input: string; text: unknown }[] = []
        const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number])
            return modelResponse(bodies.length === 1 ? longDraft() : draft())
        }) as typeof globalThis.fetch
        const result = await createReasoner(openai, { fetch: fakeFetch }).propose(context(), new AbortController().signal)
        expect(result.draft.text).toBe(draft().text); expect(bodies).toHaveLength(2)
        expect(bodies[1]?.instructions).toContain("at most 35 words")
        expect(bodies[1]?.input).toBe(bodies[0]?.input)
        expect(bodies[1]?.text).toEqual(bodies[0]?.text)
        expect(bodies[1]?.input).not.toContain(longDraft().text)
    })

    test("the text schema's character limit also permits only one length correction", async () => {
        let calls = 0
        const fakeFetch = (async (_url: string | URL | Request, _init?: RequestInit) => { calls++; return modelResponse(calls === 1 ? draft({ text: Array(90).fill("lengthy").join(" ") }) : draft()) }) as typeof globalThis.fetch
        const result = await createReasoner(openai, { fetch: fakeFetch }).propose(context(), new AbortController().signal)
        expect(calls).toBe(2); expect(result.draft.text).toBe(draft().text)
    })

    test("a second oversized answer fails without a third request or blind truncation", async () => {
        let calls = 0
        const fakeFetch = (async (_url: string | URL | Request, _init?: RequestInit) => { calls++; return modelResponse(longDraft()) }) as typeof globalThis.fetch
        await expect(createReasoner(openai, { fetch: fakeFetch }).propose(context(), new AbortController().signal)).rejects.toThrow("turn limit")
        expect(calls).toBe(2)
    })

    test("transport and length correction share a two-request budget", async () => {
        for (const transientFirst of [true, false]) {
            let calls = 0
            const fakeFetch = (async (_url: string | URL | Request, _init?: RequestInit) => { calls++; return (calls === 1) === transientFirst ? Response.json({}, { status: 503 }) : modelResponse(longDraft()) }) as typeof globalThis.fetch
            await expect(createReasoner(openai, { fetch: fakeFetch }).propose(context(), new AbortController().signal)).rejects.toThrow()
            expect(calls).toBe(2)
        }
    })

    test("cancellation after a long response prevents its corrective request", async () => {
        let calls = 0; const abort = new AbortController()
        const fakeFetch = (async (_url: string | URL | Request, _init?: RequestInit) => { calls++; abort.abort(); return modelResponse(longDraft()) }) as typeof globalThis.fetch
        await expect(createReasoner(openai, { fetch: fakeFetch }).propose(context(), abort.signal)).rejects.toThrow()
        expect(calls).toBe(1)
    })

    test("cancellation aborts an in-flight corrective request", async () => {
        let calls = 0; let retryStarted!: () => void
        const retry = new Promise<void>(resolve => { retryStarted = resolve })
        const abort = new AbortController()
        const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            calls++; if (calls === 1) return modelResponse(longDraft())
            retryStarted()
            return new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal
                if (!signal) { reject(new Error("Missing abort signal")); return }
                signal.addEventListener("abort", () => reject(signal.reason), { once: true })
            })
        }) as typeof globalThis.fetch
        const result = createReasoner(openai, { fetch: fakeFetch }).propose(context(), abort.signal)
        const outcome = result.then(() => null, (error: unknown) => error)
        await retry; abort.abort()
        expect(await outcome).toBeInstanceOf(DOMException)
        expect(calls).toBe(2)
    })

    test("theme changes update participant identities without changing the Socratic task", async () => {
        const instructions: string[] = []
        const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            instructions.push((JSON.parse(String(init?.body)) as { instructions: string }).instructions)
            return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(draft()) }] }] })
        }) as typeof globalThis.fetch
        const reasoner = createReasoner({ apiKey: "test", model: "test", reasoningEffort: null, baseUrl: "https://api.openai.com/v1" }, { fetch: fakeFetch })
        for (const theme of ["classroom", "halloween"] as const) {
            const ctx = context(); ctx.config = { ...ctx.config, theme }
            await reasoner.propose(ctx, new AbortController().signal)
        }
        expect(instructions[0]).toContain("You are Theo")
        expect(instructions[0]).not.toContain("Wednesday Addams")
        expect(instructions[1]).toContain("You are Wednesday Addams")
        expect(instructions.every(text => text.includes("collaborative Socratic seminar"))).toBe(true)
    })

    test("structured schema is strict, nullable fields are required, and only explicit credentials are sent", async () => {
        let body: Record<string, unknown> = {}; let headers = new Headers(); let destination = ""
        const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
            destination = String(url); headers = new Headers(init?.headers); body = JSON.parse(String(init?.body)) as Record<string, unknown>
            return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(draft()) }] }] })
        }) as typeof globalThis.fetch
        const reasoner = createReasoner({ apiKey: "test-hackathon-only", model: "test-model", reasoningEffort: null, baseUrl: "https://api.openai.com/v1" }, { fetch: fakeFetch })
        await reasoner.propose(context(), new AbortController().signal)
        expect(destination).toBe("https://api.openai.com/v1/responses")
        expect(headers.get("authorization")).toBe("Bearer test-hackathon-only")
        expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"])
        expect(body.store).toBe(false); expect(body.reasoning).toBeUndefined()
        const format = (body.text as { format: { strict: boolean; schema: Record<string, unknown> } }).format
        expect(format.strict).toBe(true); expect(format.schema.$schema).toBeUndefined()
        function check(value: unknown): void {
            if (Array.isArray(value)) { value.forEach(check); return }
            if (!value || typeof value !== "object") return
            const item = value as Record<string, unknown>
            if (item.type === "object") {
                expect(item.additionalProperties).toBe(false)
                expect([...(item.required as string[])].sort()).toEqual(Object.keys(item.properties as object).sort())
            }
            for (const nested of Object.values(item)) check(nested)
        }
        check(format.schema)
    })
    test("a transient error is retried once; persistent errors and cancelled work stay visible", async () => {
        let calls = 0
        const fakeFetch = (async (_url: string | URL | Request, _init?: RequestInit) => { calls++; return Response.json({}, { status: 503 }) }) as typeof globalThis.fetch
        const reasoner = createReasoner({ apiKey: "test", model: "test", reasoningEffort: null, baseUrl: "https://api.openai.com/v1" }, { fetch: fakeFetch })
        await expect(reasoner.propose(context(), new AbortController().signal)).rejects.toThrow("503")
        expect(calls).toBe(2)
        const abort = new AbortController(); abort.abort()
        await expect(reasoner.propose(context(), abort.signal)).rejects.toThrow()
        expect(calls).toBe(2)
    })
})
