import { app } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import { getApiKey } from '../store/secure-store'
import { pcmToWav, pickTtsModel } from '../core/live-voice'

// صوت Gemini (نفس صوت سعاد بالمحادثة المباشرة) للتعليق الصوتي بالدفتر. مجاني ضمن حصة المفتاح؛ إذا فشل بنرجع لـedge-tts من ناحية المنادي.
let cachedModel: string | null = null

async function voiceName(): Promise<string> {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'voice-live.json'), 'utf8')) as { voice?: string }
    if (j.voice) return j.voice
  } catch { /* default */ }
  return 'Aoede'
}

async function ttsModel(key: string): Promise<string> {
  if (cachedModel) return cachedModel
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key))
  if (!r.ok) throw new Error('تعذّر جلب لائحة الموديلات (' + r.status + ')')
  const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
  const m = pickTtsModel(j.models ?? [])
  if (!m) throw new Error('مفتاح Gemini ما عندو موديل صوت (TTS)')
  cachedModel = m
  return m
}

/** WAV (24kHz mono) بصوت Gemini. بيرمي خطأ إذا ما في مفتاح أو انتهت الحصة. */
export async function geminiSpeak(text: string): Promise<Buffer> {
  const key = getApiKey('GEMINI_API_KEY')
  if (!key) throw new Error('ما في مفتاح Gemini')
  const model = await ttsModel(key)
  const voice = await voiceName()
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  }
  for (let attempt = 0; attempt < 7; attempt++) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/' + model + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if ((r.status === 429 || r.status === 503 || r.status === 500) && attempt < 6) {
      // الحصة المجانية للـTTS قليلة بالدقيقة: منحترم وقت الانتظار يلي بيطلبو Gemini (retryDelay) أو 25 ثانية
      const txt = await r.text()
      const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(txt)
      const wait = Math.min(70000, m ? Math.ceil(parseFloat(m[1])) * 1000 + 1500 : 25000)
      await new Promise((res) => setTimeout(res, wait))
      continue
    }
    if (!r.ok) throw new Error('Gemini TTS ' + r.status + ' ' + (await r.text()).slice(0, 160))
    const j = (await r.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] }
    const b64 = j.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data)?.inlineData?.data
    if (!b64) throw new Error('Gemini TTS ما رجّع صوت')
    return Buffer.from(pcmToWav(Buffer.from(b64, 'base64')))
  }
  throw new Error('Gemini TTS: تجاوزت الحصة')
}
