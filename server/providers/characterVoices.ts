import type { SpeakerId } from "../../actor/src/roomTypes"

export interface CharacterVoiceSettings {
  stability: number
  similarity_boost: number
  style: number
  use_speaker_boost: boolean
  speed: number
}

// Cast direction, not an impersonation of the actors. Keep extra style/speaker
// boosts off; each selected voice supplies its own timbre/accent.
export const characterVoiceSettings: Record<SpeakerId, CharacterVoiceSettings> = {
  facilitator: { stability: 0.62, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 1 },
  maya: { stability: 0.6, similarity_boost: 0.8, style: 0, use_speaker_boost: false, speed: 1.02 },
  theo: { stability: 0.72, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 1 },
}
