import { cleanForSpeech, speechChunks } from '../core/speech-text'
import { liveSpeak } from './live-narrate'
import { geminiSpeak } from './gemini-tts'
import { synthDialogue } from './voice-ipc'
import { shamiSpoken } from './shami-fix'

// قاعدة ثابتة: أي شي البرنامج بيحكيه بصوت عالي بيطلع بصوت ولهجة سعاد.
// 1) النص بيتحوّل لكلام محكي شامي (Gemini). 2) سعاد بتحكيه (Gemini Live، نفس صوتها وتعليماتها).
// احتياط: Gemini TTS بنفس الصوت، وبعدين صوت سوري (edge) إذا Gemini ما رد.
const FALLBACK_VOICE = 'ar-SY-AmanyNeural'

export type SpeechPart = { mime: string; buf: Buffer }

export async function* suaadSpeak(text: string, cancelled: () => boolean = () => false): AsyncGenerator<SpeechPart> {
  let spoken = cleanForSpeech(text).slice(0, 8000)
  if (!spoken) return
  try {
    spoken = cleanForSpeech(await shamiSpoken(spoken)) || spoken
  } catch {
    /* بلا Gemini: منقرا النص متل ما هو */
  }
  let engine: 'live' | 'tts' | 'edge' = 'live'
  for (const ch of speechChunks(spoken)) {
    if (cancelled()) return
    if (engine === 'live') {
      try { yield { mime: 'audio/wav', buf: await liveSpeak(ch) }; continue } catch { engine = 'tts' }
    }
    if (engine === 'tts') {
      try { yield { mime: 'audio/wav', buf: await geminiSpeak(ch) }; continue } catch { engine = 'edge' }
    }
    yield { mime: 'audio/mpeg', buf: await synthDialogue([{ text: ch, voice: FALLBACK_VOICE }]) }
  }
}
