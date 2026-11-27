import { clientForCustomModel, listCustomModels } from './custom-models'
import { SYSTEM_PROMPT, parseAnalysis, masterClientFor } from './master'
import { cliModelAlias, cliModelName, isCliModel, runClaudeCliEx } from './cli-models'
import { subscriptionEnginesEnabled } from './feature-flags'

type TestCase = { q: string; tools: boolean; type: string }
export const MASTER_TEST_CASES: TestCase[] = [
  // 1) الفكرة الأساسية: مشغل موسيقى للموبايل مدعوم بالذكاء الاصطناعي
  { q: 'ابني تطبيق مشغل موسيقى للموبايل مدعوم بالذكاء الاصطناعي، وبيجيب كلمات الأغاني من النت تلقائياً. خطط للمشروع وابدأ بالكود', tools: true, type: 'code' },
  { q: 'صمم بنية قاعدة البيانات لتطبيق المشغل: أغاني، قوائم تشغيل، وكلمات مخزنة أوفلاين', tools: false, type: 'code' },
  { q: 'اكتبلي دالة Kotlin تجيب كلمات الأغنية من Genius API وترجع نص نظيف بدون وسوم HTML', tools: true, type: 'code' },
  { q: 'ابحث عن أفضل مكتبات Android لتشغيل الصوت بالخلفية (background playback) وقارن بينهم', tools: true, type: 'research' },
  { q: 'شو الفرق بين ExoPlayer و MediaPlayer في Android؟ أيهم أنسب لمشغل موسيقى؟', tools: false, type: 'chat' },
  { q: 'رتّب ملفات الموسيقى في مجلد Music على جهازي حسب الفنان ثم الألبوم', tools: true, type: 'file_task' },
  { q: 'شغّل اختبارات الوحدات لمشروع المشغل وقلي شو فشل ولييش', tools: true, type: 'code' },
  { q: 'اعمل صفحة landing بسيطة لتطبيق المشغل بالعربي والإنجليزي مع زر تحميل', tools: true, type: 'code' },
  { q: 'ترجم هالكلمات من أغنية إنجليزية للعربي الشامي بشكل طبيعي: I walk alone through the rain', tools: false, type: 'chat' },
  { q: 'شو أحسن طريقة أخزن كلمات الأغاني أوفلاين بدون ما أستهلك مساحة كبيرة؟', tools: false, type: 'chat' },
  { q: 'ابحث عن رسوم نشر تطبيق على Google Play Console وشروطه الحالية', tools: true, type: 'research' },
  { q: 'عدّل ملف AndroidManifest.xml وضيف صلاحيات الإنترنت وقراءة الملفات الصوتية', tools: true, type: 'file_task' },
  { q: 'اكتب سكربت PowerShell ينقل كل ملفات mp3 من مجلد Downloads لمجلد Music بدون ما يكرر الملفات', tools: true, type: 'file_task' },
  { q: 'صمم خطة مراحل لبناء المشغل من الصفر لحد النشر على المتجر، مع تقدير الوقت لكل مرحلة', tools: false, type: 'chat' },
  { q: 'راجع أمنياً كود يخزن مفتاح API بالـ SharedPreferences وقلي شو الحل الصحيح', tools: false, type: 'code' },
  { q: 'افتح المتصفح وشوف آخر إصدار من ExoPlayer على GitHub وقلي شو الجديد', tools: true, type: 'research' },
  { q: 'اقترحلي 5 أسماء عربية وإنجليزية لتطبيق المشغل', tools: false, type: 'chat' },
  { q: 'حلّل ملف logcat.txt الموجود على جهازي وقلي ليش التطبيق بيقفل فجأة', tools: true, type: 'file_task' },
  { q: 'ضيف زر في المشغل يعرض الكلمات متزامنة مع الأغنية (karaoke style) وعدّل الواجهة', tools: true, type: 'code' },
  { q: 'احسب تكلفة استدعاء Gemini API إذا كان عندي 10 آلاف مستخدم يومياً، كل واحد يطلب 20 كلمة أغنية', tools: false, type: 'chat' }
]
export type TestRow = {
  q: string
  expTools: boolean
  expType: string
  parsed: boolean
  gotTools?: boolean
  gotType?: string
  toolsOk: boolean
  typeOk: boolean
  ms: number
  error?: string
  raw?: string
}

export type ModelResult = {
  model: string
  summary: Record<string, string | number>
  rows: TestRow[]
}

const CONCURRENCY = 4
const TIMEOUT_MS = 45000

type Client = ReturnType<typeof clientForCustomModel>['client']

type Ask = (q: string) => Promise<string>
const askApi =
  (client: Client, modelId: string): Ask =>
  async (q) => {
    const r = await client.chat.completions.create(
      {
        model: modelId,
        temperature: 0.1,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: q }
        ]
      },
      { timeout: TIMEOUT_MS, maxRetries: 0 }
    )
    return r.choices[0]?.message?.content ?? ''
  }
const askCli =
  (hint: string): Ask =>
  async (q) => (await runClaudeCliEx(q, undefined, cliModelAlias(hint), 90000, undefined, SYSTEM_PROMPT)).text

// Never return an empty reason: a bare 'Error' or an empty message still has to tell the user something.
function errText(e: unknown): string {
  const st = (e as { status?: number } | null)?.status
  const m = e instanceof Error ? e.message || e.name : String(e)
  return ((st ? st + ' ' : '') + (m || 'فشل بدون رسالة')).slice(0, 200)
}

async function runCase(ask: Ask, c: TestCase): Promise<TestRow> {
  const t0 = Date.now()
  try {
    const text = await ask(c.q)
    const a = parseAnalysis(text, [])
    return {
      q: c.q,
      expTools: c.tools,
      expType: c.type,
      parsed: !!a,
      gotTools: a?.need_tools,
      gotType: a?.type,
      toolsOk: !!a && a.need_tools === c.tools,
      typeOk: !!a && a.type === c.type,
      ms: Date.now() - t0,
      raw: text.slice(0, 300)
    }
  } catch (e) {
    return {
      q: c.q,
      expTools: c.tools,
      expType: c.type,
      parsed: false,
      toolsOk: false,
      typeOk: false,
      ms: Date.now() - t0,
      error: errText(e)
    }
  }
}

export async function runModel(hint: string, opts?: { cancelled?: () => boolean; budgetMs?: number }): Promise<ModelResult> {
  // A master id picked in Settings (custom:<id>, an OpenRouter id or apinex) resolves exactly like the real master does; a plain hint is matched by model name.
  const isCli = isCliModel(hint)
  if (isCli && !subscriptionEnginesEnabled()) {
    return { model: hint, summary: { error: 'محركات الاشتراك مقفلة بهالنسخة' }, rows: [] }
  }
  const isId = isCli || hint.startsWith('custom:') || hint.startsWith('apinex:') || hint.includes('/')
  const m = isId ? null : listCustomModels().find((x) => x.model.includes(hint))
  const resolved = isCli ? null : isId ? masterClientFor(hint) : m ? clientForCustomModel(m) : null
  if (!resolved && !isCli) {
    return { model: hint, summary: { error: 'الموديل غير مضاف بالبرنامج أو ما إلو مفتاح' }, rows: [] }
  }
  const ask: Ask = isCli ? askCli(hint) : askApi(resolved!.client, resolved!.modelId)
  const modelId = isCli ? 'claude CLI' : resolved!.modelId
  const conc = isCli ? 2 : CONCURRENCY
  const rows: TestRow[] = new Array(MASTER_TEST_CASES.length)
  let next = 0
  let done = 0
  let failed = 0
  let deadStart = false
  const t0 = Date.now()
  const overBudget = (): boolean => !!opts?.budgetMs && Date.now() - t0 > opts.budgetMs
  const worker = async (): Promise<void> => {
    while (next < MASTER_TEST_CASES.length && !opts?.cancelled?.() && !deadStart && !overBudget()) {
      const i = next++
      rows[i] = await runCase(ask, MASTER_TEST_CASES[i])
      // Fail fast: if the first batch all failed, the model/key is unusable; do not burn 45 s timeouts on the rest.
      done++
      if (rows[i].error) failed++
      if (done >= conc && failed >= done) deadStart = true
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  if (opts?.cancelled?.()) return { model: hint, summary: { error: 'انلغى' }, rows: [] }
  if (deadStart) {
    const why = rows.find((r) => r?.error)?.error ?? 'فشلت كل الطلبات'
    return { model: hint, summary: { error: why }, rows: rows.filter(Boolean) }
  }
  if (overBudget() && rows.filter(Boolean).length < MASTER_TEST_CASES.length) {
    return { model: hint, summary: { error: 'بطيء جداً: ما خلّص الاختبار بالوقت المسموح (' + Math.round((opts?.budgetMs ?? 0) / 1000) + ' ثانية)' }, rows: rows.filter(Boolean) }
  }
  const n = rows.length
  return {
    model: (isCli ? cliModelName(hint) : m ? m.name : hint) + ' (' + modelId + ')',
    summary: {
      total: n,
      parsed: rows.filter((r) => r.parsed).length,
      toolsCorrect: rows.filter((r) => r.toolsOk).length,
      typeCorrect: rows.filter((r) => r.typeOk).length,
      errors: rows.filter((r) => r.error).length,
      avgMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / Math.max(n, 1))
    },
    rows
  }
}

export async function runMasterTests(hints: string[]): Promise<ModelResult[]> {
  const out: ModelResult[] = []
  for (const h of hints) out.push(await runModel(h))
  return out
}