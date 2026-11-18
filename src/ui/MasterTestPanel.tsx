import { useEffect, useMemo, useState } from 'react'

type Opt = { value: string; label: string; tier: string }

// الماستر: المستخدم يختار من كل الموديلات النازلة (مخصصة + OpenRouter + apinex)، والموصى فيه gemini-4-hydrogen (★).
export function MasterTestPanel() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [opts, setOpts] = useState<Opt[]>([])
  const [chosen, setChosen] = useState('')
  const [rec, setRec] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    void window.api.master.get().then((r) => {
      setChosen(r.value)
      setRec(r.recommended)
    })
    void window.api.master.candidates().then(setOpts)
  }, [])
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    const list = n ? opts.filter((o) => o.label.toLowerCase().includes(n) || o.value.toLowerCase().includes(n)) : opts
    // الموصى فيه أول، والباقي بترتيبه الأصلي
    return [...list.filter((o) => o.value === rec), ...list.filter((o) => o.value !== rec)]
  }, [opts, q, rec])
  const effective = chosen || rec
  const choose = async (v: string): Promise<void> => {
    setChosen(v)
    await window.api.master.set(v)
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    setMsg('جاري الاختبار… ممكن ياخد دقايق')
    try {
      const r = await window.api.masterTest.run()
      setMsg(r.ok ? 'خلص. الملف: ' + r.file + '\n' + r.summary : 'فشل: ' + (r.error ?? ''))
    } catch (e) {
      setMsg('فشل: ' + String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-4 space-y-2 border-t pt-3">
      <h3 className="text-sm font-semibold">الماستر (المصنّف)</h3>
      <p className="text-xs text-muted">اختار الموديل اللي بيحلل الطلبات. الموصى فيه ★ (يتحدّث تلقائياً مع الكتالوج).</p>
      <input
        className="w-full rounded border border-outline bg-surface px-2 py-1 text-sm"
        placeholder="ابحث عن موديل…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <select
        className="w-full rounded border border-outline bg-surface px-2 py-1 text-sm"
        size={Math.min(8, Math.max(2, shown.length))}
        value={effective}
        onChange={(e) => void choose(e.target.value)}
      >
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.value === rec ? '★ ' : ''}
            {o.label}
          </option>
        ))}
      </select>
      <button onClick={run} disabled={busy} className="rounded bg-slate-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        اختبار الماستر
      </button>
      {msg && <pre className="mt-2 whitespace-pre-wrap text-xs">{msg}</pre>}
    </div>
  )
}
