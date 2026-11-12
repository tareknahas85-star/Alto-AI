import { cleanForSpeech, speechChunks } from '../core/speech-text'
import { liveSpeak } from './live-narrate'
import { geminiSpeak } from './gemini-tts'
import { synthDialogue, vlog } from './voice-ipc'
import { shamiSpoken } from './shami-fix'

// قاعدة ثابتة: أي شي البرنامج بيحكيه بصوت عالي بيطلع بصوت ولهجة سعاد.
// 1) النص بيتحوّل لكلام محكي شامي (Gemini). 2) سعاد بتحكيه (Gemini Live، نفس صوتها وتعليماتها).
// احتياط: Gemini TTS بنفس الصوت، وبعدين صوت سوري (edge) إذا Gemini ما رد.
const FALLBACK_VOICE = 'ar-SY-AmanyNeural'

export type SpeechPart = { mime: string; buf: Buffer }

export async function* suaadSpeak(text: string, cancelled: () => boolean = () => false, opts: { rewrite?: boolean } = {}): AsyncGenerator<SpeechPart> {
  let spoken = cleanForSpeech(text).slice(0, 8000)
  if (!spoken) return
  // rewrite=false (قراءة رد محادثة): النص أصلاً جاهز، فبلاش نأخر أول صوت بإعادة صياغة
  if (opts.rewrite !== false) {
    try {
      spoken = cleanForSpeech(await shamiSpoken(spoken)) || spoken
    } catch {
      /* بلا Gemini: منقرا النص متل ما هو */
    }
  }
  let engine: 'live' | 'tts' | 'edge' = 'live'
  // أول دفعة قصيرة ليبدأ الصوت بسرعة، والباقي دفعات عادية
  let chunks = speechChunks(spoken)
  if (opts.rewrite === false) {
    const first = speechChunks(spoken, 200)[0]
    const at = first ? spoken.indexOf(first) : -1
    if (first && at >= 0) chunks = [first, ...speechChunks(spoken.slice(at + first.length).trim())]
  }
  for (const ch of chunks) {
    if (cancelled()) return
    if (engine === 'live') {
      try { yield { mime: 'audio/wav', buf: await liveSpeak(ch) }; continue } catch (e) { vlog('live failed: ' + (e as Error).message); engine = 'tts' }
    }
    if (engine === 'tts') {
      try { yield { mime: 'audio/wav', buf: await geminiSpeak(ch) }; continue } catch (e) { vlog('gemini-tts failed: ' + (e as Error).message); engine = 'edge' }
    }
    yield { mime: 'audio/mpeg', buf: await synthDialogue([{ text: ch, voice: FALLBACK_VOICE }]) }
  }
}
