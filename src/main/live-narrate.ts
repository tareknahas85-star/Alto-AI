import { app } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import WebSocket from 'ws'
import { getApiKey } from '../store/secure-store'
import { LIVE_INSTRUCTION, parseLiveAll, pcmToWav, pickLiveModel } from '../core/live-voice'

// سعاد بتقرا النص بصوتها ولهجتها: نفس جلسة Gemini Live (نفس التعليمات ونفس الصوت)، بس مهمتها تقرا الجملة بالحرف.
// هيك أي تعليق صوتي بالبرنامج بيطلع بصوت سعاد ولهجتها الشامية الحقيقية، مو بصوت TTS عادي.
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
let cachedModel: string | null = null

async function voiceName(): Promise<string> {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'voice-live.json'), 'utf8')) as { voice?: string; model?: string }
    if (j.voice) return j.voice
  } catch { /* default */ }
  return 'Aoede'
}

async function liveModel(key: string): Promise<string> {
  if (cachedModel) return cachedModel
  try {
    const j = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'voice-live.json'), 'utf8')) as { model?: string }
    if (j.model) { cachedModel = j.model.startsWith('models/') ? j.model : 'models/' + j.model; return cachedModel }
  } catch { /* pick */ }
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key))
  if (!r.ok) throw new Error('تعذّر جلب لائحة الموديلات (' + r.status + ')')
  const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
  const m = pickLiveModel(j.models ?? [])
  if (!m) throw new Error('مفتاح Gemini ما عندو موديل Live')
  cachedModel = m.name
  return m.name
}

const norm = (t: string): string[] => t.replace(/[ً-ْـ]/g, '').split(/[^؀-ۿa-z0-9]+/i).filter(Boolean)

/** نسبة كلمات الأصل يلي انقالت فعلاً (للتأكد إنو سعاد قرت النص ما علّقت عليه). */
export function spokenOverlap(original: string, transcript: string): number {
  const o = norm(original)
  if (!o.length) return 1
  const bag = new Set(norm(transcript))
  return o.filter((w) => bag.has(w)).length / o.length
}

/** WAV (24kHz mono) بصوت سعاد عبر Gemini Live. بيرمي خطأ إذا ما قدر، والمنادي بيرجع لـGemini TTS. */
export async function liveSpeak(text: string): Promise<Buffer> {
  const key = getApiKey('GEMINI_API_KEY')
  if (!key) throw new Error('ما في مفتاح Gemini')
  const model = await liveModel(key)
  const voice = await voiceName()
  return await new Promise<Buffer>((resolve, reject) => {
    const sock = new WebSocket(WS_URL + '?key=' + encodeURIComponent(key))
    const chunks: Buffer[] = []
    let said = ''
    let done = false
    const finish = (err?: Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock.close() } catch { /* ignore */ }
      if (err) return reject(err)
      if (!chunks.length) return reject(new Error('سعاد ما رجّعت صوت'))
      if (spokenOverlap(text, said) < 0.45) return reject(new Error('سعاد علّقت بدل ما تقرا النص'))
      resolve(Buffer.from(pcmToWav(Buffer.concat(chunks))))
    }
    const timer = setTimeout(() => finish(new Error('انتهى الوقت وسعاد عم تقرا')), 90000)
    sock.on('error', (e) => finish(e instanceof Error ? e : new Error(String(e))))
    sock.on('close', () => finish())
    sock.on('open', () => sock.send(JSON.stringify({
      setup: {
        model,
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
        systemInstruction: { parts: [{ text: LIVE_INSTRUCTION + ' مهمتك هلأ: تقري النص يلي بيوصلك بالحرف وبصوتك ولهجتك الشامية، بدون مقدمة ولا تعليق ولا إضافة ولا حذف.' }] },
        outputAudioTranscription: {},
      },
    })))
    sock.on('message', (data) => {
      for (const ev of parseLiveAll(data.toString())) {
        if (ev.type === 'ready') sock.send(JSON.stringify({ realtimeInput: { text: 'اقري هالنص بالحرف، بدون أي إضافة:\n' + text } }))
        else if (ev.type === 'audio') chunks.push(Buffer.from(ev.data, 'base64'))
        else if (ev.type === 'modelText') said += ' ' + ev.text
        else if (ev.type === 'turnComplete') finish()
        else if (ev.type === 'error') finish(new Error(ev.error))
      }
    })
  })
}
