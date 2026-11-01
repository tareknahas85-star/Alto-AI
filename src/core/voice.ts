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
    .replace(/[*_~>|#=\u005E\\\/]+/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, ' ')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/\s*[()\[\]{}]\s*/g, ', ')
    .replace(/([.!?؟،,:؛]){2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEECH_CHARS)
}

export function pickVoice(text: string): string {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length
  const lat = (text.match(/[A-Za-z]/g) ?? []).length
  return ar >= lat ? VOICE_AR : VOICE_EN
}

export const SPEECH_RATE = '-10%'

export interface Segment { text: string; lang: 'ar' | 'en' }

/** Splits text into Arabic and Latin runs so each run gets a voice that can really pronounce it. */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = []
  const re = /([A-Za-z][A-Za-z0-9 '\-.,]*[A-Za-z0-9])|([^A-Za-z]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const t = m[0].trim()
    if (!t || !/[\p{L}\p{N}]/u.test(t)) continue
    const lang: 'ar' | 'en' = m[1] ? 'en' : 'ar'
    const last = out[out.length - 1]
    if (last && last.lang === lang) last.text += ' ' + t
    else out.push({ text: t, lang })
  }
  return out
}
