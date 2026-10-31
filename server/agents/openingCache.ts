import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { ProposalDraftSchema } from "../../shared/contracts"
import { castPersona, classroomPersona } from "../../topics"
import { SPEAKING_PROMPT_CACHE_VERSION, validateDraft } from "./reasoner"
import type { AgentContext, Reasoner } from "./types"
import type { ProposalDraft } from "../../shared/contracts"

const CACHE_VERSION = 2
const entrySchema = z.object({ version: z.literal(CACHE_VERSION), key: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.number().int().nonnegative(), draft: ProposalDraftSchema }).strict()
const MAX_ENTRY_BYTES = 32_768
const MAX_ENTRIES = 12
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
interface OpeningCacheOptions {
    directory: string
    model: string
    reasoningEffort: string | null
}
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
    if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
    return JSON.stringify(value) ?? "null"
}
function eligible(context: AgentContext): boolean {
    if (context.config.topicId !== "swe-retries" || context.topic.id !== "swe-retries" || context.config.format !== "socratic"
        || context.config.customQuestion || context.config.reading || context.evidence.length || context.privateNotes.length
        || context.generationEpoch !== 1 || context.roomVersion !== context.transcript.length + 1 || context.trigger.utteranceId !== null) return false
    if (context.agentId === "facilitator") return context.transcript.length === 0 && context.board.length === 0 && context.hint.mode === "open"
        && context.trigger.kind === "session.started" && context.trigger.actorId === "bridge" && context.trigger.replyTo === null
    const expected = context.agentId === "maya" ? ["facilitator"] : ["facilitator", "maya"]
    const last = context.transcript.at(-1)
    return context.transcript.length === expected.length && context.transcript.every((item, index) => item.speakerId === expected[index] && item.status === "heard" && item.heardText.trim())
        && context.board.every(card => card.authorId !== "human") && context.hint.mode === "peer-exchange" && context.hint.preferredSpeakers.includes(context.agentId)
        && context.trigger.kind === "contribution.heard" && context.trigger.actorId === last?.speakerId && context.trigger.replyTo === last?.id
        && context.trigger.payload.contributionId === last?.id && context.trigger.payload.heardText === last?.heardText && !context.trigger.payload.interrupted
}
type References = { contributions: Map<string, string>; cards: Map<string, string> }
function references(context: AgentContext): References | null {
    const contributions = new Map(context.transcript.map((item, index) => [item.id, `@contribution:${index}`]))
    const cards = new Map(context.board.map((item, index) => [item.id, `@board:${index}`]))
    return contributions.size === context.transcript.length && cards.size === context.board.length ? { contributions, cards } : null
}
function remap(id: string | null, mapping: Map<string, string>): string | null {
    if (id === null) return null
    const mapped = mapping.get(id)
    if (!mapped) throw new Error("Unmapped cached context reference")
    return mapped
}
function remapDraft(draft: ProposalDraft, refs: References): ProposalDraft {
    const next = structuredClone(draft)
    next.replyToContributionId = remap(next.replyToContributionId, refs.contributions)
    if (next.boardUpdate) {
        next.boardUpdate.targetCardId = remap(next.boardUpdate.targetCardId, refs.cards)
        if (next.boardUpdate.attributeToHumanContributionId !== null) throw new Error("Human attribution cannot be cached")
    }
    return next
}
function cacheableDraft(draft: ProposalDraft, context: AgentContext): boolean {
    return draft.action === "contribute" && draft.replyToContributionId === (context.transcript.at(-1)?.id ?? null) && draft.evidenceRequest === null
        && draft.sourceIds.every(id => context.topic.sources.some(source => source.id === id))
        && (!draft.boardUpdate || draft.boardUpdate.attributeToHumanContributionId === null
            && (draft.boardUpdate.targetCardId === null || context.board.some(card => card.id === draft.boardUpdate?.targetCardId && card.status !== "dismissed")))
}
function contextKey(context: AgentContext, options: OpeningCacheOptions, refs: References): string {
    // Only transport identifiers change. Heard wording, sources, board content/relations and all
    // other model context must match exactly; draft references are rebound for the receiving room.
    const { relayChannel: _channel, ...config } = context.config
    const { fixtureLines: _fixtures, ...topic } = context.topic
    const { roomId: _room, sessionId: _session, eventId: _event, ...rawTrigger } = context.trigger
    const trigger = { ...rawTrigger, replyTo: remap(rawTrigger.replyTo, refs.contributions) }
    if (trigger.kind === "contribution.heard") {
        const contributionId = remap(trigger.payload.contributionId, refs.contributions)
        if (contributionId === null) throw new Error("Missing contribution reference")
        trigger.payload = { ...trigger.payload, contributionId, replyToContributionId: remap(trigger.payload.replyToContributionId, refs.contributions) }
    }
    const transcript = context.transcript.map(item => ({ ...item, id: remap(item.id, refs.contributions), replyToContributionId: remap(item.replyToContributionId, refs.contributions) }))
    const board = context.board.map(card => ({ ...card, id: remap(card.id, refs.cards), relations: card.relations.map(relation => ({ ...relation, targetCardId: remap(relation.targetCardId, refs.cards) })) }))
    return createHash("sha256").update(stableJson({
        cacheVersion: CACHE_VERSION, version: SPEAKING_PROMPT_CACHE_VERSION, model: options.model, reasoningEffort: options.reasoningEffort,
        agentId: context.agentId, config: { ...config, theme: config.theme ?? "classroom" }, topic,
        transcript, board, hint: context.hint, trigger, roomVersion: context.roomVersion, generationEpoch: context.generationEpoch,
        persona: context.config.theme === "halloween" ? castPersona[context.agentId] : classroomPersona[context.agentId],
    })).digest("hex")
}
async function prune(directory: string): Promise<void> {
    const now = Date.now()
    const entries = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
        const path = join(directory, name)
        try { return { path, modifiedAt: (await stat(path)).mtimeMs } } catch { return null }
    }))
    const sorted = entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => b.modifiedAt - a.modifiedAt)
    await Promise.all(sorted.filter((entry, index) => index >= MAX_ENTRIES || now - entry.modifiedAt > MAX_AGE_MS).map(entry => rm(entry.path, { force: true })))
}

/** Reuses only the first three untouched SWE turns. Human input, later replies and tools bypass. */
export function withOpeningCache(reasoner: Reasoner, options: OpeningCacheOptions): Reasoner {
    if (reasoner.mode !== "openai") return reasoner
    return {
        ...reasoner,
        label: `${reasoner.label} · opening exchange cache enabled, replies live`,
        async propose(context, signal) {
            signal.throwIfAborted()
            if (!eligible(context)) return reasoner.propose(context, signal)
            const refs = references(context)
            if (!refs) return reasoner.propose(context, signal)
            let key:string
            try { key = contextKey(context, options, refs) } catch { return reasoner.propose(context, signal) }
            const currentRefs:References = { contributions: new Map([...refs.contributions].map(([actual, canonical]) => [canonical, actual])), cards: new Map([...refs.cards].map(([actual, canonical]) => [canonical, actual])) }
            const start = performance.now(); const path = join(options.directory, `${key}.json`)
            try {
                if ((await stat(path)).size <= MAX_ENTRY_BYTES) {
                    const cached = entrySchema.parse(JSON.parse(await readFile(path, "utf8")))
                    signal.throwIfAborted()
                    if (cached.key === key && Date.now() - cached.createdAt <= MAX_AGE_MS && cached.createdAt <= Date.now()) {
                        const rebound = remapDraft(cached.draft, currentRefs)
                        if (cacheableDraft(rebound, context)) {
                            const draft = validateDraft(rebound, context)
                            if (cacheableDraft(draft, context)) return { draft, latencyMs: Math.round(performance.now() - start), cacheHit: true }
                        }
                    }
                }
            } catch { signal.throwIfAborted() }
            const result = await reasoner.propose(context, signal)
            signal.throwIfAborted()
            const draft = validateDraft(result.draft, context)
            if (!cacheableDraft(result.draft, context) || !cacheableDraft(draft, context)) return { ...result, draft, cacheHit: false }
            const temporary = join(options.directory, `.${key}.${randomUUID()}.tmp`)
            try {
                await mkdir(options.directory, { recursive: true, mode: 0o700 })
                signal.throwIfAborted()
                await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, key, createdAt: Date.now(), draft: remapDraft(draft, refs) }), { mode: 0o600, signal })
                signal.throwIfAborted()
                await rename(temporary, path)
                await prune(options.directory)
            } catch { signal.throwIfAborted() }
            finally { await rm(temporary, { force: true }).catch(() => undefined) }
            signal.throwIfAborted()
            return { ...result, draft, cacheHit: false }
        },
    }
}
