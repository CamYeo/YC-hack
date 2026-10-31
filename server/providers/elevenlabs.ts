import type { ElevenLabsConfig } from "../config/types"
import type { Logger } from "../log"
import { characterVoiceSettings } from "./characterVoices"
import type { SpeakerId } from "../../actor/src/roomTypes"

export class ElevenLabsError extends Error {
    constructor(message: string, readonly status: number | null = null) { super(message); this.name = "ElevenLabsError" }
}
export function createElevenLabsClient(config: ElevenLabsConfig, logger?: Logger, dependencies: { fetch?: typeof globalThis.fetch } = {}) {
    const base = "https://api.elevenlabs.io"
    const fetcher = dependencies.fetch ?? globalThis.fetch
    const speechRequest = (voiceId: string, text: string) => {
        const speaker = (Object.keys(config.voices) as SpeakerId[]).find(id => config.voices[id] === voiceId)
        if (!speaker) throw new ElevenLabsError("Voice is not configured for this seminar")
        if (!text.trim() || text.length > 4000) throw new ElevenLabsError("Invalid speech segment")
        return { voiceId, text, modelId: config.ttsModels?.[speaker] ?? config.ttsModel, outputFormat: "mp3_44100_128", voiceSettings: { ...characterVoiceSettings[speaker] } }
    }
    const request = async (path: string, body: unknown | undefined, signal?: AbortSignal) => {
        let response: Response
        try {
            response = await fetcher(`${base}${path}`, { method: "POST", headers: { "xi-api-key": config.apiKey, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), redirect: "error" })
        } catch (error) { if (signal?.aborted) throw error; throw new ElevenLabsError("ElevenLabs could not be reached") }
        if (!response.ok) {
            if (response.status === 402) {
                const error = await response.json().catch(() => null) as { detail?: { code?: string } } | null
                if (error?.detail?.code === "paid_plan_required") throw new ElevenLabsError("This ElevenLabs voice requires library API access in your hackathon account. Enable it in ElevenLabs, or use a stock voice.", 402)
            } else await response.body?.cancel()
            throw new ElevenLabsError(`ElevenLabs request failed (${response.status})`, response.status)
        }
        return response
    }
    return {
        speechRequest,
        async mintScribeToken(): Promise<{ token: string; modelId: string }> {
            const response = await request("/v1/single-use-token/realtime_scribe", undefined)
            const data: unknown = await response.json()
            if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string") throw new ElevenLabsError("ElevenLabs returned an invalid transcription token")
            logger?.debug("Minted single-use transcription token")
            return { token: data.token, modelId: config.sttModel }
        },
        async streamSpeech(voiceId: string, text: string, signal?: AbortSignal): Promise<Response> {
            const speech = speechRequest(voiceId, text)
            return request(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${speech.outputFormat}`, { text: speech.text, model_id: speech.modelId, voice_settings: speech.voiceSettings }, signal)
        },
    }
}
export type ElevenLabsClient = ReturnType<typeof createElevenLabsClient>
