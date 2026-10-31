import { readHackathonFile } from "../server/config/hackathonConfig"

export async function listHackathonVoices(repoRoot = process.cwd()): Promise<{ id: string; name: string; labels: Record<string, string> }[]> {
    const key = readHackathonFile(repoRoot).HACKATHON_ELEVENLABS_API_KEY
    if (!key) throw new Error("Missing HACKATHON_ELEVENLABS_API_KEY")
    const response = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15000), redirect: "error" })
    if (!response.ok) throw new Error(`ElevenLabs voice listing failed (${response.status})`)
    const data: unknown = await response.json()
    if (!data || typeof data !== "object" || !("voices" in data) || !Array.isArray(data.voices)) throw new Error("Unexpected ElevenLabs voice listing response")
    return data.voices.flatMap((v: unknown) => {
        if (!v || typeof v !== "object" || !("voice_id" in v) || typeof v.voice_id !== "string" || !("name" in v) || typeof v.name !== "string") return []
        const labels: Record<string,string> = {}
        if ("labels" in v && v.labels && typeof v.labels === "object") for (const [k,value] of Object.entries(v.labels)) if (typeof value === "string") labels[k] = value
        return [{ id: v.voice_id, name: v.name, labels }]
    })
}
if (import.meta.main) {
    try { for (const voice of await listHackathonVoices()) process.stdout.write(`${voice.id}\t${voice.name}\t${JSON.stringify(voice.labels)}\n`) }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Voice lookup failed"}\n`); process.exitCode = 1 }
}
