import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { loadHackathonConfig } from "../server/config/hackathonConfig"
import { createElevenLabsClient } from "../server/providers/elevenlabs"
import { createSpeechCache } from "../server/speech/cache"
import { createTerseRoomStore } from "../server/terse/terseRoomStore"
import { splitIntoSegments } from "../shared/contracts"

const argument = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const roomId = argument("--room"), filename = argument("--file")
if ((!roomId && !filename) || (roomId && filename)) {
    process.stderr.write("Usage: bun --no-env-file scripts/warmSpeechCache.ts (--room ROOM_ID | --file dialogue.json) [--dry-run]\nJSON format: [{\"speakerId\":\"facilitator\",\"text\":\"An approved line to prepare.\"}]\nThis prepares reusable ElevenLabs audio; it does not script or replace live seminar reasoning.\n")
    process.exit(1)
}
const root = resolve(argument("--repo-root") ?? process.cwd())
const config = loadHackathonConfig(root)
if (!config.elevenlabs) { process.stderr.write("Complete the hackathon ElevenLabs voice configuration first.\n"); process.exit(1) }
const lineSchema = z.array(z.object({ speakerId: z.enum(["facilitator", "maya", "theo"]), text: z.string().min(1).max(4000) })).min(1).max(100)
let lines: z.infer<typeof lineSchema>
if (filename) lines = lineSchema.parse(JSON.parse(await readFile(resolve(filename), "utf8")))
else {
    const state = await createTerseRoomStore(config.terse).getSnapshot(roomId ?? "")
    lines = lineSchema.parse(state.contributions.filter(contribution => contribution.speakerId !== "human" && contribution.heardText.trim()).map(contribution => ({ speakerId: contribution.speakerId, text: contribution.heardText })))
}
const characters = lines.reduce((sum, line) => sum + line.text.length, 0)
if (characters > 20_000) { process.stderr.write("Preparation is limited to 20,000 characters per run. Select a shorter excerpt.\n"); process.exit(1) }
const segments = lines.flatMap(line => splitIntoSegments(line.text).map(text => ({ speakerId: line.speakerId, text })))
process.stdout.write(`Prepare ${segments.length} speech segments (${characters} characters). Cache misses use only the configured hackathon ElevenLabs key.\n`)
if (process.argv.includes("--dry-run")) { process.stdout.write("Dry run: no speech generated. Exact text and settings must match later to reuse audio.\n"); process.exit(0) }
const eleven = createElevenLabsClient(config.elevenlabs)
const cache = createSpeechCache({ directory: join(root, ".local", "speech-cache"), generate: (request, signal) => eleven.streamSpeech(request.voiceId, request.text, signal) })
const abort = new AbortController()
process.once("SIGINT", () => abort.abort())
try {
    let complete = 0
    for (const segment of segments) {
        await cache.prewarm(eleven.speechRequest(config.elevenlabs.voices[segment.speakerId], segment.text), { signal: abort.signal })
        process.stdout.write(`Prepared ${++complete}/${segments.length}.\n`)
    }
    const stats = await cache.stats()
    process.stdout.write(`Ready: ${stats.files} cached audio files (${stats.bytes} bytes). These are generated recordings, not freshly synthesized playback. This command does not change dialogue selection.\n`)
} catch {
    process.stderr.write(abort.signal.aborted ? "Audio preparation cancelled.\n" : "Audio preparation failed; inspect hackathon voice configuration or provider availability. No credentials were logged.\n")
    process.exitCode = 1
} finally { await cache.close() }
