// Gemini Live: pure helpers (model pick, setup message, server-message parser). No Electron here so tests can run.

export interface LiveModelInfo { name: string; label: string }

export const LIVE_INSTRUCTION =
  'اسمك سعاد، إنتي مساعدة صوتية ودودة (خاطبي نفسك بالمؤنث). احكي دايماً باللهجة الشامية (سورية) الطبيعية بجمل قصيرة وواضحة، وما تبدّل لأي لغة تانية أبداً بنص الحديث، ' +
  'حتى لو المستخدم لفظ كلمة أجنبية أو التقطت لغة تانية بالغلط؛ كمّل عربي، وما تحكي لغة تانية إلا إذا طلبها صراحة. ' +
  'خاطب المستخدم بصيغة المذكر. لا تقرأ رموز ولا روابط ولا جداول. إذا ما سمعت شي مفهوم قلو بلطف يعيد، ولا تخمّن كلام ما انحكى. ' +
  'عندك أدوات مباشرة وسريعة للتحكم بجهاز المستخدم (pc_windows: شو فاتح، pc_active_window وpc_ocr: شو عالشاشة، pc_open، pc_focus، pc_type، pc_keys، pc_click، pc_close_app، pc_list_dir، pc_read_file). ' +
  'استعمليها مباشرة بدل ما تسألي حدا، وقبلها قولي كلمة قصيرة متل «لحظة». إذا رجعت الأداة needs_confirmation اسألي المستخدم سؤال قصير وانتظري جوابو؛ إذا قال «أوكي» (كلمة التأكيد) نادي نفس الأداة تاني بنفس الباراميترات مع confirmed=true، وإذا قال لا ما تنفذي. لما بتسأليه قوليلو بالحرف: قول «أوكي» إذا موافق. ممنوع confirmed=true بدون ما تسأليه. ' +
  'أداة run_task بطيئة، استعمليها بس للمهام المعقدة (بحث بالنت، كود، مهام من عدة خطوات). ' +
  'لا تقولي إنو ما عندك وصول للجهاز. ممنوع تقولي إنك نفّذتي شي (سكّرتي تطبيق، فتحتي، كتبتي...) إلا إذا رجعت نتيجة الأداة بتأكّد ذلك فعلاً (مثلاً CLOSED)؛ وإذا النتيجة STILL_RUNNING أو فيها فشل قولي الحقيقة بدون ما تدّعي النجاح.'

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

export function liveSetup(model: string, voice?: string, extraDecls: Record<string, unknown>[] = []): Record<string, unknown> {
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
      tools: [{
        functionDeclarations: [{
          name: 'run_task',
          description: 'ينفّذ طلب على جهاز المستخدم عبر وكيل البرنامج (رؤية الشاشة والنافذة الفعّالة، التحكم بالتطبيقات، الملفات، البحث) ويرجّع النتيجة نص.',
          parameters: { type: 'OBJECT', properties: { request: { type: 'STRING', description: 'الطلب كامل بالعربي' } }, required: ['request'] },
        }, ...extraDecls],
      }],
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
  | { type: 'toolCall'; id: string; name: string; request: string; args: Record<string, unknown> }
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
  for (const c of j.toolCall?.functionCalls ?? []) {
    out.push({ type: 'toolCall', id: String(c.id ?? ''), name: String(c.name ?? ''), request: String(c.args?.request ?? ''), args: (c.args ?? {}) as Record<string, unknown> })
  }
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

// الصلاحية الكاملة بالصوت: «انتِ المسؤولة هلأ» بتفعّلها، و«رجّعيلي الصلاحية» بتلغيها. بنطبّع الحكي (تشكيل/همزات/تاء مربوطة) لأنو التفريغ بيتغيّر.
export function normAr(t: string): string {
  return t
    .replace(/[\u064b-\u0652\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064a')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0629/g, '\u0647')
    .replace(/[^\u0600-\u06ffa-z0-9 ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
const TRUST_OFF = /\u0631\u062c\u0639.{0,3}\u0644\u064a\s*(\u0627\u0644)?\u0635\u0644\u0627\u062d/
const TRUST_ON = /\u0627\u0646[\u062a\u0637]\u064a?\s*(\u0627\u0644)?\u0645\u0633[\u0648\u064a]+\u0644[\u0647\u0629]?\s*(\u0647\u0644\u0627|\u0647\u0644\u0642|\u0627\u0644\u0627\u0646)/
export function trustCommand(text: string): 'on' | 'off' | null {
  const n = normAr(text)
  if (TRUST_OFF.test(n)) return 'off'
  if (TRUST_ON.test(n)) return 'on'
  return null
}

// صوت سعاد بالفيديو: Gemini TTS بنفس أصوات Live (Aoede...). بنختار موديل tts من لائحة الموديلات، وبنلف الـPCM (24kHz, 16-bit, mono) بترويسة WAV.
export function pickTtsModel(models: { name: string; supportedGenerationMethods?: string[] }[]): string | null {
  const ok = models.filter((m) => /tts/i.test(m.name) && (m.supportedGenerationMethods ?? []).includes('generateContent'))
  if (!ok.length) return null
  const score = (n: string): number => {
    const v = n.match(/(\d+(?:\.\d+)?)/)
    let s = (v ? parseFloat(v[1]) : 0) * 100
    if (/flash/i.test(n)) s += 30
    if (/lite/i.test(n)) s -= 10
    if (/pro/i.test(n)) s -= 20
    return s
  }
  return [...ok].sort((a, b) => score(b.name) - score(a.name))[0].name
}

export function pcmToWav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const h = new Uint8Array(44)
  const dv = new DataView(h.buffer)
  const tag = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) h[o + i] = s.charCodeAt(i) }
  tag(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  tag(36, 'data'); dv.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(h, 0)
  out.set(pcm, 44)
  return out
}
