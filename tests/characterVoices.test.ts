import { expect, test } from "bun:test"
import { createElevenLabsClient } from "../server/providers/elevenlabs"
import type { ElevenLabsConfig } from "../server/config/types"

const config: ElevenLabsConfig = { apiKey: "test-only-key", voices: { facilitator: "jack", maya: "dracula", theo: "wednesday" }, ttsModel: "eleven_flash_v2_5", sttModel: "scribe_v2_realtime", baseUrl: "https://api.elevenlabs.io" }

test("cache identity includes exactly the voice settings sent to ElevenLabs", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const client = createElevenLabsClient(config, undefined, { fetch: (async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) })
    return new Response(new Uint8Array([73, 68, 51]))
  }) as typeof fetch })
  for (const voice of Object.values(config.voices)) {
    const speech = client.speechRequest(voice, "What does a timeout prove?")
    await client.streamSpeech(voice, speech.text)
    expect(calls.at(-1)?.body).toEqual({ text: speech.text, model_id: speech.modelId, voice_settings: speech.voiceSettings })
    expect(calls.at(-1)?.url).toContain(`output_format=${speech.outputFormat}`)
  }
  expect(client.speechRequest("wednesday", "Hello").voiceSettings.stability).toBeGreaterThan(client.speechRequest("jack", "Hello").voiceSettings.stability)
  expect(() => client.speechRequest("unknown", "Hello")).toThrow("not configured")
  expect(() => client.speechRequest("jack", " ")).toThrow("Invalid speech")
  expect(calls).toHaveLength(3)
})

test("library access failures give an actionable message without provider details", async () => {
  const client = createElevenLabsClient(config, undefined, { fetch: (async () => Response.json({ detail: { code: "paid_plan_required", message: "do not expose this raw provider detail" } }, { status: 402 })) as unknown as typeof fetch })
  await expect(client.streamSpeech("jack", "Hello")).rejects.toThrow("requires library API access in your hackathon account")
})

test("quality overrides change only the selected characters and the cache descriptor", () => {
  const client = createElevenLabsClient({ ...config, ttsModels: { facilitator: "eleven_multilingual_v2", theo: "eleven_multilingual_v2" } })
  expect(client.speechRequest("jack", "Hello").modelId).toBe("eleven_multilingual_v2")
  expect(client.speechRequest("wednesday", "Hello").modelId).toBe("eleven_multilingual_v2")
  expect(client.speechRequest("dracula", "Hello").modelId).toBe("eleven_flash_v2_5")
})
