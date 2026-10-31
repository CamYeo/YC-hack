import { readFile, writeFile, rename, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { loadHackathonConfig } from "../server/config/hackathonConfig"
import { createElevenLabsClient } from "../server/providers/elevenlabs"
import type { SpeakerId } from "../actor/src/roomTypes"

const library = process.argv.includes("--library")
if (!library && !process.argv.includes("--stock")) {
  process.stderr.write("Usage: bun --no-env-file scripts/selectCharacterVoices.ts --library|--stock\nVerifies three short ElevenLabs samples before changing the hackathon voice IDs.\n")
  process.exit(2)
}
const root = process.cwd()
const config = loadHackathonConfig(root)
if (!config.elevenlabs) throw new Error("Complete the hackathon ElevenLabs configuration first")
const selected: { seat: SpeakerId; name: string; id: string }[] = library ? [
  { seat: "facilitator", name: "Alaric — theatrical Jack", id: "gUU37agQvEpxeWrZUIMk" },
  { seat: "maya", name: "Paul — Transylvanian Dracula", id: "5BZv9Z02hAMUmkkcd5Hj" },
  { seat: "theo", name: "Nayva — low, restrained Wednesday", id: "cfc7wVYq4gw4OpcEEAom" },
] : [
  { seat: "facilitator", name: "Callum — expressive trickster", id: "N2lVS1w4EtoT3dr4eOWO" },
  { seat: "maya", name: "George — measured British storyteller", id: "JBFqnCBsd6RMkjVDRZzb" },
  { seat: "theo", name: "Sarah — restrained young American", id: "EXAVITQu4vr4xnSDxMaL" },
]
try {
  // A paid TTS key can synthesize public library IDs directly. Do not request
  // voices_write or change the user's collection just to select a seminar voice.
  const voices = { ...config.elevenlabs.voices }
  for (const voice of selected) voices[voice.seat] = voice.id
  const client = createElevenLabsClient({ ...config.elevenlabs, voices })
  const samples: Record<SpeakerId, string> = {
    facilitator: "Your payment request timed out. Dracula, what would you try next?",
    maya: "I would retry the request. Wednesday, what could make that unsafe?",
    theo: "A timeout proves you did not get a response. It does not prove the payment failed.",
  }
  await mkdir(join(root, ".local", "voice-auditions"), { recursive: true })
  for (const voice of selected) {
    const response = await client.streamSpeech(voice.id, samples[voice.seat])
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length < 100) throw new Error(`Empty audio for ${voice.name}`)
    await writeFile(join(root, ".local", "voice-auditions", `${voice.seat}.mp3`), bytes, { mode: 0o600 })
    process.stdout.write(`Verified ${voice.name}.\n`)
  }
  const path = join(root, ".env.hackathon.local")
  let source = await readFile(path, "utf8")
  for (const voice of selected) {
    const name = `HACKATHON_VOICE_${voice.seat.toUpperCase()}`
    const pattern = new RegExp(`^${name}=.*$`, "m")
    if (pattern.test(source)) source = source.replace(pattern, `${name}=${voice.id}`)
    else source += `\n${name}=${voice.id}\n`
  }
  const temporary = `${path}.tmp`
  await writeFile(temporary, source, { mode: 0o600 })
  await rename(temporary, path)
  process.stdout.write(`Saved ${library ? "library character" : "stock fallback"} voices. Restart the backend to load them. No credentials were printed.\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Voice setup failed"}\nThe configured voice IDs were not changed.\n`)
  process.exitCode = 1
}
