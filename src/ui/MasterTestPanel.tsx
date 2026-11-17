import { useEffect, useState } from 'react'

type Opt = { value: string; label: string; tier: string }

// الماستر: المستخدم يختار من كل الموديلات المخصصة، والموصى فيه gemini-4-hydrogen (★).
export function MasterTestPanel() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [opts, setOpts] = useState<Opt[]>([])
  const [chosen, setChosen] = useState('')
  const [rec, setRec] = useState('')
  useEffect(() => {
    void window.api.master.get().then((r) => {
      setChosen(r.value)
      setRec(r.recommended)
    })
    void window.api.modelPicker().then((list) => setOpts(list.filter((p) => p.value.startsWith('custom:'))))
  }, [])
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
      <p className="text-xs text-muted">اختار الموديل اللي بيحلل الطلبات. الموصى فيه ★.</p>
      <select
        className="w-full rounded border border-outline bg-surface px-2 py-1 text-sm"
        value={effective}
        onChange={(e) => void choose(e.target.value)}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.value === rec ? '  ★ الأفضل' : ''}
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
