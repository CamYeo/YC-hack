// Hackathon-only configuration contract. Implemented by ./hackathonConfig.ts.
//
// Rules (from the build spec, section 2):
// - Values come ONLY from `<repoRoot>/.env.hackathon.local` (parsed explicitly) and, for the Relay
//   workspace key, optionally from `<repoRoot>/.local/relay-workspace.json` minted by
//   `bun run relay:bootstrap`. `process.env` is never consulted for provider credentials.
// - No fallback to OPENAI_API_KEY, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, default orgs/projects,
//   proxies or gateways inherited from the shell.
// - Missing values are reported by variable NAME only.

export type AppMode = "live" | "fixture"

export interface OpenAIConfig {
    apiKey: string
    model: string
    /** Only sent when set (reasoning models). */
    reasoningEffort: "minimal" | "low" | "medium" | null
    /** Always https://api.openai.com/v1 — never taken from the environment. */
    baseUrl: string
}

export interface ElevenLabsConfig {
    apiKey: string
    voices: { facilitator: string; maya: string; theo: string }
    ttsModel: string
    /** Optional per-character quality overrides; audio cache keys include the resolved model. */
    ttsModels?: Partial<Record<"facilitator" | "maya" | "theo", string>>
    sttModel: string
    /** Always https://api.elevenlabs.io — never taken from the environment. */
    baseUrl: string
}

export interface RelayConfig {
    baseUrl: string
    workspaceKey: string
    /** Where the key came from, for the status panel (never the value). */
    keySource: "env-file" | "bootstrap-file"
    workspaceId: string | null
}

export interface TerseConfig {
    /** Full actor endpoint, e.g. http://127.0.0.1:7100/v1/projects/local/actors */
    actorUrl: string
}

export interface HackathonConfig {
    appMode: AppMode
    repoRoot: string
    /** Explicit opt-in: reuse the first three untouched, previously generated SWE exchanges. */
    cacheOpening: boolean
    /** null → reasoning uses the clearly-labelled fixture reasoner. */
    openai: OpenAIConfig | null
    /** null → voices use browser speechSynthesis (labelled fixture); transcription uses browser fallback/text. */
    elevenlabs: ElevenLabsConfig | null
    /** null → in-memory relay (labelled fixture; only allowed in fixture mode). */
    relay: RelayConfig | null
    terse: TerseConfig
    server: { host: "127.0.0.1"; port: number; allowedOrigins: string[] }
    /** Variable names that are missing or blank, grouped by provider. Never values. */
    missing: { openai: string[]; elevenlabs: string[]; relay: string[] }
}

export class ConfigError extends Error {
    readonly missing: string[]
    constructor(message: string, missing: string[]) {
        super(message)
        this.name = "ConfigError"
        this.missing = missing
    }
}
