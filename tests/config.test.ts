import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { loadHackathonConfig, parseHackathonEnv } from "../server/config/hackathonConfig"
import { ConfigError } from "../server/config/types"
import { bootstrapRelay } from "../scripts/relayBootstrap"

const roots: string[] = []
function root(source?: string) { const dir = mkdtempSync(join(tmpdir(), "apprentice-config-test-")); roots.push(dir); if (source !== undefined) writeFileSync(join(dir, ".env.hackathon.local"), source); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe("hackathon credential isolation", () => {
    test("absent file never falls back to inherited provider credentials", () => {
        const dir = root()
        const module = resolve("server/config/hackathonConfig.ts")
        const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `import {loadHackathonConfig} from ${JSON.stringify(module)}; const c=loadHackathonConfig(${JSON.stringify(dir)}); process.stdout.write(JSON.stringify({openai:c.openai,elevenlabs:c.elevenlabs,relay:c.relay}));`], { cwd: dir, env: { OPENAI_API_KEY: "inherited-must-not-use", HACKATHON_OPENAI_API_KEY: "also-must-not-use", ELEVENLABS_API_KEY: "inherited-must-not-use", OPENAI_BASE_URL: "https://example.invalid" } })
        expect(child.exitCode).toBe(0)
        expect(JSON.parse(child.stdout.toString())).toEqual({ openai: null, elevenlabs: null, relay: null })
    })
    test("reads explicit file values without shell expansion", () => {
        expect(parseHackathonEnv("# ignored\nA='$(echo secret)'\nB=hello # comment\nC=\"literal$VALUE\"\n")).toEqual({ A: "$(echo secret)", B: "hello", C: "literal$VALUE" })
        const c = loadHackathonConfig(root("HACKATHON_OPENAI_API_KEY=test-only-key\nHACKATHON_OPENAI_MODEL=test-model\n"))
        expect(c.openai?.apiKey).toBe("test-only-key")
        expect(c.openai?.baseUrl).toBe("https://api.openai.com/v1")
        expect(c.elevenlabs).toBeNull()
        expect(c.missing.elevenlabs).toContain("HACKATHON_VOICE_THEO")
        expect(c.cacheOpening).toBe(false)
    })
    test("opening reuse requires an explicit valid hackathon-file opt-in", () => {
        expect(loadHackathonConfig(root("HACKATHON_CACHE_OPENING=true\n")).cacheOpening).toBe(true)
        expect(loadHackathonConfig(root("HACKATHON_CACHE_OPENING=false\n")).cacheOpening).toBe(false)
        expect(() => loadHackathonConfig(root("HACKATHON_CACHE_OPENING=maybe\n"))).toThrow(ConfigError)
    })
    test("live mode refuses missing voice IDs and reports names only", () => {
        try { loadHackathonConfig(root("APP_MODE=live\nHACKATHON_ELEVENLABS_API_KEY=do-not-print-this\n")); throw new Error("Expected config refusal") }
        catch (error) { expect(error).toBeInstanceOf(ConfigError); expect((error as Error).message).not.toContain("do-not-print-this"); expect((error as ConfigError).missing).toContain("HACKATHON_VOICE_MAYA") }
    })
    test("honors only local bootstrap Relay credentials", () => {
        const dir = root(); mkdirSync(join(dir, ".local"))
        writeFileSync(join(dir, ".local", "relay-workspace.json"), JSON.stringify({ workspaceId: "test-ws", workspaceKey: "test-only-workspace", baseUrl: "https://armadillo.agentrelay.com/v1" }))
        expect(loadHackathonConfig(dir).relay?.keySource).toBe("bootstrap-file")
    })
    test("rejects provider endpoint substitution and nonlocal actor URL", () => {
        expect(() => loadHackathonConfig(root("HACKATHON_RELAY_WORKSPACE_KEY=test\nHACKATHON_RELAY_BASE_URL=https://example.invalid/v1"))).toThrow(ConfigError)
        expect(() => loadHackathonConfig(root("TERSE_LOCAL_URL=https://example.invalid"))).toThrow(ConfigError)
    })
    test("known unsupported bootstrap idempotency falls back once and persists privately", async () => {
        const dir = root()
        const realFetch = globalThis.fetch
        const calls: { keyed: boolean; url: string }[] = []
        globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
            const keyed = new Headers(options?.headers).has("Idempotency-Key")
            calls.push({ keyed, url: String(url) })
            return keyed ? new Response(JSON.stringify({ ok: false, error: { code: "workspace_create_idempotency_unavailable" } }), { status: 503 }) : Response.json({ ok: true, data: { workspace_id: "fake-workspace", api_key: "fake-only-key" } })
        }) as typeof fetch
        try {
            const config = await bootstrapRelay(dir)
            expect(config.workspaceId).toBe("fake-workspace")
            expect(calls.map(c => c.keyed)).toEqual([true, false])
            expect(calls.every(c => c.url === "https://armadillo.agentrelay.com/v1/workspaces")).toBe(true)
            expect(statSync(join(dir, ".local", "relay-workspace.json")).mode & 0o777).toBe(0o600)
            await bootstrapRelay(dir)
            expect(calls).toHaveLength(2)
        } finally { globalThis.fetch = realFetch }
    })
})
