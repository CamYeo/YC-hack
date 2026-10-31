import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { ConfigError, type HackathonConfig, type RelayConfig } from "./types"

/** A deliberately small dotenv reader: no environment interpolation or SDK defaults. */
export function parseHackathonEnv(source: string): Record<string, string> {
    const values: Record<string, string> = {}
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith("#")) continue
        const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
        if (!match) throw new ConfigError("Invalid line in .env.hackathon.local", [])
        const name = match[1]
        const rawValue = match[2]
        if (name === undefined || rawValue === undefined) throw new ConfigError("Invalid line in .env.hackathon.local", [])
        let value = rawValue.trim()
        if (value.startsWith('"') || value.startsWith("'")) {
            const quote = value.charAt(0)
            const end = value.lastIndexOf(quote)
            if (end === 0) throw new ConfigError(`Unclosed value for ${name}`, [name])
            const suffix = value.slice(end + 1).trim()
            if (suffix && !suffix.startsWith("#")) throw new ConfigError(`Invalid value for ${name}`, [name])
            value = value.slice(1, end)
        } else value = value.replace(/\s+#.*$/, "").trim()
        values[name] = value
    }
    return values
}

export function readHackathonFile(repoRoot = process.cwd()): Record<string, string> {
    const path = join(repoRoot, ".env.hackathon.local")
    return existsSync(path) ? parseHackathonEnv(readFileSync(path, "utf8")) : {}
}

export function relayBaseUrl(value?: string, key?: string): string {
    const base = (value || "https://armadillo.agentrelay.com/v1").replace(/\/$/, "")
    if (!["https://armadillo.agentrelay.com/v1", "https://cast.agentrelay.com/v1"].includes(base)) {
        throw new ConfigError("HACKATHON_RELAY_BASE_URL must be an official hosted Relay endpoint", ["HACKATHON_RELAY_BASE_URL"])
    }
    if (key?.startsWith("rk_")) return "https://cast.agentrelay.com/v1"
    return base
}

export function readRelayConfig(repoRoot: string, values = readHackathonFile(repoRoot)): RelayConfig | null {
    const key = values.HACKATHON_RELAY_WORKSPACE_KEY?.trim()
    if (key) return { baseUrl: relayBaseUrl(values.HACKATHON_RELAY_BASE_URL, key), workspaceKey: key, keySource: "env-file", workspaceId: null }
    const path = join(repoRoot, ".local", "relay-workspace.json")
    if (!existsSync(path)) return null
    let saved: unknown
    try { saved = JSON.parse(readFileSync(path, "utf8")) } catch { throw new ConfigError("Invalid local Relay workspace file", []) }
    if (!saved || typeof saved !== "object") throw new ConfigError("Invalid local Relay workspace file", [])
    const s = saved as Record<string, unknown>
    if (typeof s.workspaceKey !== "string" || !s.workspaceKey || typeof s.workspaceId !== "string") throw new ConfigError("Invalid local Relay workspace file", [])
    return { baseUrl: relayBaseUrl(typeof s.baseUrl === "string" ? s.baseUrl : values.HACKATHON_RELAY_BASE_URL, s.workspaceKey), workspaceKey: s.workspaceKey, keySource: "bootstrap-file", workspaceId: s.workspaceId }
}

export function loadHackathonConfig(repoRoot = process.cwd()): HackathonConfig {
    const root = resolve(repoRoot)
    const v = readHackathonFile(root)
    const mode = v.APP_MODE || "fixture"
    if (mode !== "live" && mode !== "fixture") throw new ConfigError("APP_MODE must be live or fixture", ["APP_MODE"])
    const missing = {
        openai: ["HACKATHON_OPENAI_API_KEY", "HACKATHON_OPENAI_MODEL"].filter(n => !v[n]?.trim()),
        elevenlabs: ["HACKATHON_ELEVENLABS_API_KEY", "HACKATHON_VOICE_FACILITATOR", "HACKATHON_VOICE_MAYA", "HACKATHON_VOICE_THEO"].filter(n => !v[n]?.trim()),
        relay: [] as string[],
    }
    const effort = v.HACKATHON_OPENAI_REASONING_EFFORT?.trim() || null
    if (effort && !["minimal", "low", "medium"].includes(effort)) throw new ConfigError("Invalid HACKATHON_OPENAI_REASONING_EFFORT", ["HACKATHON_OPENAI_REASONING_EFFORT"])
    const cacheOpening = v.HACKATHON_CACHE_OPENING?.trim() || "false"
    if (!["true", "false"].includes(cacheOpening)) throw new ConfigError("HACKATHON_CACHE_OPENING must be true or false", ["HACKATHON_CACHE_OPENING"])
    const relay = readRelayConfig(root, v)
    if (!relay) missing.relay.push("HACKATHON_RELAY_WORKSPACE_KEY")
    const actorUrl = v.TERSE_LOCAL_URL || "http://127.0.0.1:7100/v1/projects/local/actors"
    let url: URL
    try { url = new URL(actorUrl) } catch { throw new ConfigError("Invalid TERSE_LOCAL_URL", ["TERSE_LOCAL_URL"]) }
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new ConfigError("TERSE_LOCAL_URL must address the local runtime", ["TERSE_LOCAL_URL"])
    const port = Number(v.HACKATHON_SERVER_PORT || "3001")
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError("Invalid HACKATHON_SERVER_PORT", ["HACKATHON_SERVER_PORT"])
    if (mode === "live") {
        const names = [...missing.openai, ...missing.elevenlabs, ...missing.relay]
        if (names.length) throw new ConfigError(`Missing hackathon configuration: ${names.join(", ")}`, names)
    }
    const configured = (name: string): string => {
        const value = v[name]
        if (!value?.trim()) throw new ConfigError(`Missing hackathon configuration: ${name}`, [name])
        return value
    }
    return {
        appMode: mode, repoRoot: root, cacheOpening: cacheOpening === "true",
        openai: missing.openai.length ? null : { apiKey: configured("HACKATHON_OPENAI_API_KEY"), model: configured("HACKATHON_OPENAI_MODEL"), reasoningEffort: effort as "minimal" | "low" | "medium" | null, baseUrl: "https://api.openai.com/v1" },
        elevenlabs: missing.elevenlabs.length ? null : { apiKey: configured("HACKATHON_ELEVENLABS_API_KEY"), voices: { facilitator: configured("HACKATHON_VOICE_FACILITATOR"), maya: configured("HACKATHON_VOICE_MAYA"), theo: configured("HACKATHON_VOICE_THEO") }, ttsModel: v.HACKATHON_TTS_MODEL || "eleven_flash_v2_5", ttsModels: { ...(v.HACKATHON_TTS_MODEL_FACILITATOR?.trim() ? { facilitator: v.HACKATHON_TTS_MODEL_FACILITATOR.trim() } : {}), ...(v.HACKATHON_TTS_MODEL_MAYA?.trim() ? { maya: v.HACKATHON_TTS_MODEL_MAYA.trim() } : {}), ...(v.HACKATHON_TTS_MODEL_THEO?.trim() ? { theo: v.HACKATHON_TTS_MODEL_THEO.trim() } : {}) }, sttModel: v.HACKATHON_STT_MODEL || "scribe_v2_realtime", baseUrl: "https://api.elevenlabs.io" },
        relay, terse: { actorUrl: actorUrl.replace(/\/$/, "") },
        server: { host: "127.0.0.1", port, allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"] }, missing,
    }
}
