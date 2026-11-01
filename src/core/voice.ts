// Read-aloud helpers (pure). Syrian Arabic gets the Syrian neural voice (feminine, per the user's preference); other text gets an English voice.

export const VOICE_AR = 'ar-SY-AmanyNeural'
export const VOICE_EN = 'en-US-AriaNeural'
export const MAX_SPEECH_CHARS = 2500

/** Markdown/code/links stripped so the voice doesn't read symbols aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEECH_CHARS)
}

export function pickVoice(text: string): string {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length
  const lat = (text.match(/[A-Za-z]/g) ?? []).length
  return ar >= lat ? VOICE_AR : VOICE_EN
}
