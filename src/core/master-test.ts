import { clientForCustomModel, listCustomModels } from './custom-models'
import { SYSTEM_PROMPT, parseAnalysis } from './master'

type TestCase = { q: string; tools: boolean; type: string }

// Expected labels written by hand: tools=true when the request needs live data, files, code execution or the computer.
export const MASTER_TEST_CASES: TestCase[] = [
  { q: 'ترجم هالجملة للإنجليزي: مرحبا كيفك', tools: false, type: 'chat' },
  { q: 'شو عاصمة فرنسا؟', tools: false, type: 'chat' },
  { q: 'اكتبلي دالة بايثون تحسب الفيبوناتشي', tools: true, type: 'code' },
  { q: 'شو استهلاك الـ CPU الحالي على جهازي؟', tools: true, type: 'file_task' },
  { q: 'افتح الحاسبة', tools: true, type: 'file_task' },
  { q: 'لخّص هالنص بجملتين: الذكاء الاصطناعي تقنية تحاكي التفكير البشري في حل المشاكل', tools: false, type: 'chat' },
  { q: 'ابحث على النت عن آخر أخبار Gemini', tools: true, type: 'research' },
  { q: 'شو في داخل الملف C:\\temp\\notes.txt؟', tools: true, type: 'file_task' },
  { q: 'اشرحلي شو هو الـ Kubernetes Pod ببساطة', tools: false, type: 'chat' },
  { q: 'عدّل الدالة بهالملف وصلّح الباغ', tools: true, type: 'code' },
  { q: 'احسب 17 ضرب 23', tools: false, type: 'chat' },
  { q: 'شو الطقس بدمشق اليوم؟', tools: true, type: 'research' },
  { q: 'اكتبلي رسالة شكر قصيرة لمديري', tools: false, type: 'chat' },
  { q: 'ارسم صورة قطة فضائية', tools: true, type: 'file_task' },
  { q: 'اعمللي صفحة HTML بسيطة لعرض منتجاتي', tools: true, type: 'code' },
  { q: 'افتحلي Gmail وشوف آخر إيميل', tools: true, type: 'file_task' },
  { q: 'شو الفرق بين TCP و UDP؟', tools: false, type: 'chat' },
  { q: 'شغّل سكربت PowerShell يعرض الملفات الأكبر من 1 غيغا', tools: true, type: 'file_task' },
  { q: 'ترجم هالفقرة للفرنسي: الطقس جميل اليوم', tools: false, type: 'chat' },
  { q: 'اقترحلي اسم لمشروعي الجديد', tools: false, type: 'chat' }
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

export async function runMasterTest(modelHint: string): Promise<{ model: string; summary: Record<string, string | number>; rows: TestRow[] }> {
  const m = listCustomModels().find((x) => x.model.includes(modelHint))
  if (!m) throw new Error('ما لقيت موديل ' + modelHint + ' مضاف بالبرنامج. أضفه من صفحة الموديلات أولاً.')
  const { client, modelId } = clientForCustomModel(m)
  const rows: TestRow[] = []
  for (const c of MASTER_TEST_CASES) {
    const t0 = Date.now()
    try {
      const r = await client.chat.completions.create(
        {
          model: modelId,
          temperature: 0.1,
          max_tokens: 300,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: c.q }
          ]
        },
        { timeout: 60000, maxRetries: 0 }
      )
      const text = r.choices[0]?.message?.content ?? ''
      const a = parseAnalysis(text, [])
      rows.push({
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
      })
    } catch (e) {
      rows.push({
        q: c.q,
        expTools: c.tools,
        expType: c.type,
        parsed: false,
        toolsOk: false,
        typeOk: false,
        ms: Date.now() - t0,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e)
      })
    }
  }
  const n = rows.length
  const summary = {
    total: n,
    parsed: rows.filter((r) => r.parsed).length,
    toolsCorrect: rows.filter((r) => r.toolsOk).length,
    typeCorrect: rows.filter((r) => r.typeOk).length,
    errors: rows.filter((r) => r.error).length,
    avgMs: Math.round(rows.reduce((s, r) => s + r.ms, 0) / Math.max(n, 1))
  }
  return { model: m.name + ' (' + modelId + ')', summary, rows }
}