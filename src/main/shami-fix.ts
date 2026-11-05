import { getApiKey } from '../store/secure-store'
import { LIVE_INSTRUCTION } from '../core/live-voice'
import { buildShamiFixPrompt } from '../core/notebook'

// إعادة صياغة النص بالشامي عبر Gemini (نفس مفتاح سعاد): الموديلات المجانية العامة أوقات بتكتب مصري أو فصحى، وGemini أقوى بالشامي.
let cachedModel: string | null = null

async function textModel(key: string): Promise<string> {
  if (cachedModel) return cachedModel
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key))
  if (!r.ok) throw new Error('models ' + r.status)
  const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
  const ok = (j.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent') && /flash/i.test(m.name) && !/tts|live|image|audio|embed|lite|thinking|exp|preview/i.test(m.name))
  const ver = (n: string): number => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0 }
  const best = ok.sort((a, b) => ver(b.name) - ver(a.name))[0]
  if (!best) throw new Error('ما في موديل Gemini نصي')
  cachedModel = best.name
  return best.name
}

/** بيرجّع نص الـJSON المعاد صياغتو بالشامي (كتلة ```json)، أو بيرمي خطأ والمنادي بيرجع للموديل العادي. */
export async function shamiRewriteDeck(deckBody: string): Promise<string> {
  const key = getApiKey('GEMINI_API_KEY')
  if (!key) throw new Error('ما في مفتاح Gemini')
  const model = await textModel(key)
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/' + model + ':generateContent?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: LIVE_INSTRUCTION.split('.')[0] + '. مهمتك إعادة صياغة النص بلهجتك الشامية السورية العامية الطبيعية.' }] },
      contents: [{ role: 'user', parts: [{ text: buildShamiFixPrompt(deckBody) }] }],
      generationConfig: { temperature: 0.4 },
    }),
  })
  if (!r.ok) throw new Error('Gemini ' + r.status)
  const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text.trim()) throw new Error('Gemini رجّع فاضي')
  return text
}
