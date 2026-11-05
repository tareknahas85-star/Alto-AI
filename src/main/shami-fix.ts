import { getApiKey } from '../store/secure-store'
import { LIVE_INSTRUCTION } from '../core/live-voice'
import { SHAMI_STRICT, buildShamiFixPrompt } from '../core/notebook'

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

async function geminiShami(prompt: string, task: string): Promise<string> {
  const key = getApiKey('GEMINI_API_KEY')
  if (!key) throw new Error('ما في مفتاح Gemini')
  const model = await textModel(key)
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/' + model + ':generateContent?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: LIVE_INSTRUCTION.split('.')[0] + '. ' + task }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4 },
    }),
  })
  if (!r.ok) throw new Error('Gemini ' + r.status)
  const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  if (!text.trim()) throw new Error('Gemini رجّع فاضي')
  return text
}

/** بيرجّع نص الـJSON المعاد صياغتو بالشامي (كتلة ```json)، أو بيرمي خطأ والمنادي بيرجع للموديل العادي. */
export async function shamiRewriteDeck(deckBody: string): Promise<string> {
  return geminiShami(buildShamiFixPrompt(deckBody), 'مهمتك إعادة صياغة النص بلهجتك الشامية السورية العامية الطبيعية.')
}

/** بيحوّل أي نص (نتيجة وكيل، رد، تقرير) لكلام محكي بالشامي متل ما سعاد بتقراه بصوت عالي. */
export async function shamiSpoken(text: string): Promise<string> {
  const prompt =
    'حوّل النص اللي تحت لكلام محكي، متل ما رح تقريه بصوتك لصاحبك عالتلفون.\n' +
    SHAMI_STRICT + '\n' +
    '- خلّي كل المعلومات المهمة والأرقام والأسماء متل ما هي، وما تزيد معلومات من عندك وما تعلّق.\n' +
    '- بلا رموز ولا روابط ولا جداول؛ القوائم صيّرها جمل متتالية.\n' +
    '- إذا النص إنجليزي أو فصحى، احكيه بالشامي، واترك أسماء البرامج والمصطلحات التقنية متل ما هي.\n' +
    '- رجّع الكلام المحكي بس، بلا مقدمة ولا عنوان.\n\n' +
    'النص:\n' + text
  return geminiShami(prompt, 'مهمتك تحكي النصوص بلهجتك الشامية السورية العامية الطبيعية.')
}
