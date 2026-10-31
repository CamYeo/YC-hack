import { describe, expect, test } from "bun:test"
import { createToolRunner, paymentRetry } from "../server/tools/toolRunner"
import { createTopicRegistry } from "../topics"
import type { TopicPack } from "../shared/topic"
function topic(id = "swe-retries"): TopicPack {
    const p = createTopicRegistry().get(id)
    if (!p) throw new Error("Missing fixture topic")
    return p
}
describe("deterministic payment experiment", () => {
    test.each([["no-key-retry", 2], ["stable-key-retry", 1], ["new-key-retry", 2]] as const)("%s produces %d charges", (caseId, charges) => {
        const result = paymentRetry(caseId)
        expect(result.metrics.charges).toBe(charges); expect(result.metrics.attempts).toBe(2)
        expect(result.events.some(e => e.label === "Response lost")).toBe(true)
        expect(result.assumptions.join(" ")).toContain("simulated server")
        expect(result.limitations.join(" ")).toContain("toy simulation")
        expect(paymentRetry(caseId)).toEqual(result)
    })
    test("stable key returns the original receipt", () => {
        const events = paymentRetry("stable-key-retry").events
        expect(events.find(e => e.label === "Charge committed")?.detail).toBe("receipt-1")
        expect(events.find(e => e.label === "Stored receipt returned")?.detail).toBe("receipt-1")
    })
})
describe("topic tool boundary", () => {
    const runner = createToolRunner()
    test("unknown tools, unknown cases and cross-topic tools return failed", () => {
        for (const [p, toolId, caseId] of [[topic(), "invented", null], [topic(), "payment-retry-sim", "bad-case"], [topic(), "source-lookup", "invented-source"], [topic("math-multiplication"), "payment-retry-sim", "stable-key-retry"]] as const) {
            expect(runner.run({ topic: p, toolId, caseId, question: "Test" }).status).toBe("failed")
        }
    })
    test("all source statements cite bundled sources; no sources is a visible failure", () => {
        const p = topic(); const result = runner.run({ topic: p, toolId: "source-lookup", caseId: null, question: "Read" })
        expect(result.status).toBe("returned")
        if (result.status !== "returned") throw new Error(result.error)
        for (const statement of result.result.sourceStatements) expect(p.sources.some(s => s.id === statement.sourceId)).toBe(true)
        expect(runner.run({ topic: { ...p, sources: [] }, toolId: "source-lookup", caseId: null, question: "Read" }).status).toBe("failed")
    })
    test("math distinguishes counterexamples from proof and honors case identifiers", () => {
        const p = topic("math-multiplication")
        const result = runner.run({ topic: p, toolId: "multiply-check", caseId: "examples", question: "Does multiplication increase value?" })
        expect(result.status).toBe("returned")
        if (result.status !== "returned") throw new Error(result.error)
        expect(result.result.observations).toContain("4 × 0.5 = 2; less than 4.")
        expect(result.result.limitations.join(" ")).toContain("does not prove")
        expect(runner.run({ topic: p, toolId: "multiply-check", caseId: "made-up", question: "?" }).status).toBe("failed")
    })
})
