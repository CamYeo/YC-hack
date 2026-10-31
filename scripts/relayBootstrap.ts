import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readHackathonFile, readRelayConfig, relayBaseUrl } from "../server/config/hackathonConfig"
import type { RelayConfig } from "../server/config/types"
import { AnonymousIdempotencyUnavailableError, isRecord, relayRequest, savePrivateJson } from "../server/providers/relay/liveRelay"

/** Creates only this project's new hackathon workspace; never searches other accounts. */
export async function bootstrapRelay(repoRoot = process.cwd()): Promise<RelayConfig> {
    const values = readHackathonFile(repoRoot)
    const existing = readRelayConfig(repoRoot, values)
    if (existing) return existing
    const dir = join(repoRoot, ".local")
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
    const pendingPath = join(dir, "relay-bootstrap.json")
    let operation: { name: string; idempotencyKey: string; standardAttempted?: boolean }
    if (existsSync(pendingPath)) {
        const raw: unknown = JSON.parse(readFileSync(pendingPath, "utf8"))
        if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.idempotencyKey !== "string") throw new Error("Malformed local bootstrap operation")
        operation = { name: raw.name, idempotencyKey: raw.idempotencyKey, standardAttempted: raw.standardAttempted === true }
    } else {
        operation = { name: `apprentice-haunted-hacks-${crypto.randomUUID()}`, idempotencyKey: crypto.randomUUID() }
        savePrivateJson(pendingPath, operation)
    }
    const baseUrl = relayBaseUrl(values.HACKATHON_RELAY_BASE_URL)
    const body = { name: operation.name, provenance: { source: "api", classification: "external" } }
    let data: unknown
    try { data = await relayRequest(baseUrl, null, "POST", "/workspaces", body, operation.idempotencyKey) }
    catch (error) {
        if (!(error instanceof AnonymousIdempotencyUnavailableError)) throw error
        // The current hosted deployment explicitly rejects keyed anonymous creates before creating
        // anything. Fall back to the documented standard create once, on the SAME endpoint/name.
        // Do not replay an uncertain unkeyed request: credentials may have been returned only once.
        if (operation.standardAttempted) throw new Error("Previous standard Relay bootstrap needs recovery; no second workspace was created", { cause: error })
        operation.standardAttempted = true
        savePrivateJson(pendingPath, operation)
        data = await relayRequest(baseUrl, null, "POST", "/workspaces", body)
    }
    if (!isRecord(data) || typeof data.api_key !== "string" || typeof data.workspace_id !== "string") throw new Error("Relay bootstrap returned an invalid response")
    const config: RelayConfig = { baseUrl, workspaceId: data.workspace_id, workspaceKey: data.api_key, keySource: "bootstrap-file" }
    savePrivateJson(join(dir, "relay-workspace.json"), { ...config, createdAt: new Date().toISOString(), purpose: "APPRENTICE Haunted Hacks localhost demo" })
    return config
}
if (import.meta.main) {
    try { const config = await bootstrapRelay(); process.stdout.write(`Hackathon Relay workspace ready (${config.keySource}). Credentials saved privately in .local/.\n`) }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Relay bootstrap failed"}\n`); process.exitCode = 1 }
}
