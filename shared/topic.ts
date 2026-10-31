// Topic packs: checked-in data that shapes a session (question, goals, sources, lenses, tools).
// Plain TypeScript, safe to import from the server and (type-only) from the browser.

import type { Difficulty, Format, SpeakerId, TopicCategory } from "../actor/src/roomTypes"

export interface SourceSummary {
    /** Stable id cited by agents and board cards, e.g. "aws-retries". */
    id: string
    title: string
    url: string
    /** Short ORIGINAL summary (never copied article text). */
    summary: string
    /** A few short paraphrased points agents may cite. */
    keyPoints: string[]
}

export interface ToolCase {
    id: string
    label: string
    description: string
}

export interface TopicTool {
    /** e.g. "payment-retry-sim", "source-lookup", "multiply-check", "climate-series" */
    id: string
    label: string
    description: string
    /** Explicit, displayed assumptions of the deterministic tool. */
    assumptions: string[]
    cases: ToolCase[]
}

export interface Lens {
    /** One-line role framing for this topic, e.g. "explore retrying as the default". */
    stance: string
    /** Optional opening hypothesis — framed as a hypothesis, never as settled truth. */
    initialHypothesis: string | null
}

export interface FixtureLine {
    /** Lowercase keywords; the fixture reasoner prefers lines whose keywords appear in the trigger. */
    keywords: string[]
    text: string
    addressedTo: "human" | "maya" | "theo" | "group"
    action: "contribute" | "request_evidence"
    evidence: { toolId: string; caseId: string | null; question: string } | null
    board: { kind: "claim" | "question" | "revision"; text: string; relation: "supports" | "challenges" | "revises" | "answers" | null } | null
    sourceIds: string[]
}

export interface TopicPack {
    id: string
    category: TopicCategory
    title: string
    /** Short description for the home screen. */
    blurb: string
    defaultFormat: Format
    defaultDifficulty: Difficulty
    openingQuestion: string
    learningGoals: string[]
    /** Empty means "not evidence-backed": factual claims must be labelled unresolved. */
    sources: SourceSummary[]
    lenses: Record<SpeakerId, Lens>
    tools: TopicTool[]
    reflectionPrompts: string[]
    /**
     * Clearly-labelled FIXTURE dialogue used only when OpenAI is not configured. Never used in
     * OpenAI mode. Keyed by speaker; the fixture reasoner picks context-matching unused lines.
     */
    fixtureLines: Record<SpeakerId, FixtureLine[]>
}

/** Home-screen quick-start card. */
export interface Preset {
    id: "swe-seminar" | "science" | "general-knowledge" | "math" | "custom"
    label: string
    description: string
    category: TopicCategory
    topicId: string
    format: Format
    difficulty: Difficulty
}

/** What GET /api/topics returns: presets plus per-category packs (no fixture lines, no full sources). */
export interface TopicSummary {
    id: string
    category: TopicCategory
    title: string
    blurb: string
    openingQuestion: string
    defaultFormat: Format
    defaultDifficulty: Difficulty
    learningGoals: string[]
    evidenceBacked: boolean
    sources: { id: string; title: string; url: string }[]
    tools: { id: string; label: string; description: string; assumptions: string[]; cases: ToolCase[] }[]
}

export interface TopicsResponse {
    presets: Preset[]
    topics: TopicSummary[]
}
