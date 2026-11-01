// Gemini Live: pure helpers (model pick, setup message, server-message parser). No Electron here so tests can run.

export interface LiveModelInfo { name: string; label: string }

export const LIVE_INSTRUCTION =
  'إنت مساعد صوتي ودود. احكي باللهجة الشامية (سورية) الطبيعية متل الحكي اليومي، بجمل قصيرة وواضحة. ' +
  'خاطب المستخدم بصيغة المذكر. لا تقرأ رموز ولا روابط ولا جداول. إذا المستخدم حكى إنكليزي جاوبو بالإنكليزي. ' +
  'إذا ما سمعت شي مفهوم قلو بلطف يعيد، ولا تخمّن كلام ما انحكى.'

function versionOf(name: string): number {
  const m = name.match(/(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : 0
}

// يختار أقوى موديل بيدعم bidiGenerateContent: الأعلى إصداراً، بدون lite، وبدون thinking إلا إذا ما في غيرو (السرعة أهم بالحكي).
export function pickLiveModel(models: { name: string; supportedGenerationMethods?: string[] }[]): LiveModelInfo | null {
  const ok = models.filter((m) => (m.supportedGenerationMethods ?? []).includes('bidiGenerateContent'))
  if (!ok.length) return null
  const score = (n: string): number => {
    let s = versionOf(n) * 100
    if (/live/i.test(n)) s += 20
    if (/native-audio/i.test(n)) s += 10
    if (/lite/i.test(n)) s -= 60
    if (/think/i.test(n)) s -= 30
    if (/preview|exp/i.test(n)) s -= 1
    return s
  }
  const best = [...ok].sort((a, b) => score(b.name) - score(a.name))[0]
  return { name: best.name, label: best.name.replace(/^models\//, '') }
}

export function liveSetup(model: string, voice?: string): Record<string, unknown> {
  return {
    setup: {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Aoede' } } },
      },
      systemInstruction: { parts: [{ text: LIVE_INSTRUCTION }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }
}

export type LiveEvent =
  | { type: 'ready' }
  | { type: 'audio'; data: string }
  | { type: 'interrupted' }
  | { type: 'turnComplete' }
  | { type: 'userText'; text: string }
  | { type: 'modelText'; text: string }
  | { type: 'goAway' }
  | { type: 'error'; error: string }
  | { type: 'ignore' }

// رسالة وحدة من السيرفر ممكن تحمل أكتر من حدث (صوت + تفريغ).
export function parseLiveAll(raw: string): LiveEvent[] {
  let j: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  try { j = JSON.parse(raw) } catch { return [{ type: 'ignore' }] }
  const out: LiveEvent[] = []
  if (j.setupComplete) out.push({ type: 'ready' })
  if (j.goAway) out.push({ type: 'goAway' })
  if (j.error) out.push({ type: 'error', error: String(j.error.message ?? JSON.stringify(j.error)) })
  const sc = j.serverContent
  if (sc) {
    if (sc.interrupted) out.push({ type: 'interrupted' })
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) out.push({ type: 'audio', data: String(p.inlineData.data) })
    }
    if (sc.inputTranscription?.text) out.push({ type: 'userText', text: String(sc.inputTranscription.text) })
    if (sc.outputTranscription?.text) out.push({ type: 'modelText', text: String(sc.outputTranscription.text) })
    if (sc.turnComplete) out.push({ type: 'turnComplete' })
  }
  return out.length ? out : [{ type: 'ignore' }]
}
