import { useEffect, useMemo, useRef, useState } from 'react'

type Scan = { qualified: boolean; parsed: number; tools: number; avgMs: number; at: number } | null
type Opt = { value: string; label: string; tier: string; scan: Scan }
type Entry = { id: string; label: string; parsed: number; tools: number; avgMs: number; qualified: boolean; error?: string }
type ScanSt = { running: boolean; total: number; done: number; current: string; error?: string; at: number; entries: Entry[] }

// الماستر: بعد الفحص بيظهر بالقائمة بس الموديلات المؤهَّلة (✓)، والباقي بيتخبّى وراء «عرض الكل». الموصى فيه gemini-4-hydrogen (★).
export function MasterTestPanel() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [opts, setOpts] = useState<Opt[]>([])
  const [chosen, setChosen] = useState('')
  const [rec, setRec] = useState('')
  const [q, setQ] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [scanSt, setScanSt] = useState<ScanSt | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const loadOpts = (): void => {
    void window.api.master.candidates().then((l) => setOpts(l as Opt[]))
  }
  useEffect(() => {
    void window.api.master.get().then((r) => {
      setChosen(r.value)
      setRec(r.recommended)
    })
    loadOpts()
    void window.api.masterScan.status().then((s) => setScanSt(s as ScanSt))
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [])
  const effective = chosen || rec
  const anyQualified = opts.some((o) => o.scan?.qualified)
  const strongOnly = anyQualified && !showAll
  const shown = useMemo(() => {
    const base = strongOnly ? opts.filter((o) => o.scan?.qualified || o.value === effective || o.value === rec) : opts
    const n = q.trim().toLowerCase()
    const list = n ? base.filter((o) => o.label.toLowerCase().includes(n) || o.value.toLowerCase().includes(n)) : base
    // الموصى فيه أول، والباقي بترتيبه الأصلي
    return [...list.filter((o) => o.value === rec), ...list.filter((o) => o.value !== rec)]
  }, [opts, q, rec, effective, strongOnly])
  const hidden = strongOnly ? opts.length - opts.filter((o) => o.scan?.qualified || o.value === effective || o.value === rec).length : 0
  const badge = (o: Opt): string => (o.scan ? (o.scan.qualified ? ' ✓ ' + o.scan.parsed + '/20' : ' ✗') : '')
  const choose = async (v: string): Promise<void> => {
    setChosen(v)
    try {
      const saved = await window.api.master.set(v)
      // Do not trust the optimistic highlight: show what the app really stored.
      setChosen(saved)
      if (saved !== v) setMsg('ما انحفظ الماستر: المحفوظ فعلياً ' + (saved || '(الافتراضي)'))
    } catch (e) {
      setMsg('فشل حفظ الماستر: ' + String(e))
    }
  }
  const probe = async (): Promise<void> => {
    setBusy(true)
    setMsg('عم جرّب الماستر المختار…')
    try {
      const r = await window.api.master.probe()
      setMsg(
        'المختار: ' + (r.chosen || '(الافتراضي)') + '\nالشغّال فعلياً: ' + (r.masterModel || r.source || '—') + ' (' + r.source + ') · ' + r.ms + 'ms' + (r.masterError ? '\nفشل: ' + r.masterError : '')
      )
    } catch (e) {
      setMsg('فشل: ' + String(e))
    } finally {
      setBusy(false)
    }
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
  const stopTimer = (): void => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }
  const scan = async (): Promise<void> => {
    setMsg('عم أتأكد من الاتصال…')
    try {
      const r = await window.api.masterScan.start()
      if (!r.ok) {
        setMsg(r.error ?? 'ما انبدأ الفحص')
        return
      }
      setMsg('')
      const tick = async (): Promise<void> => {
        const s = (await window.api.masterScan.status()) as ScanSt
        setScanSt(s)
        if (!s.running) {
          stopTimer()
          loadOpts()
          const ok = s.entries.filter((e) => e.qualified).length
          setMsg('خلص الفحص: ' + ok + ' مؤهَّل من ' + s.entries.length + (s.error ? '\nخطأ: ' + s.error : ''))
        }
      }
      stopTimer()
      timer.current = setInterval(() => void tick(), 1500)
      void tick()
    } catch (e) {
      setMsg('فشل الفحص: ' + String(e))
    }
  }
  const cancelScan = async (): Promise<void> => {
    await window.api.masterScan.cancel()
    setMsg('عم ألغي الفحص…')
  }
  const clearScan = async (): Promise<void> => {
    await window.api.masterScan.clear()
    setScanSt((await window.api.masterScan.status()) as ScanSt)
    loadOpts()
    setMsg('انمسحت نتائج الفحص، رجعت القائمة كاملة')
  }
  const scanning = !!scanSt?.running
  return (
    <div className="mt-4 space-y-2 border-t pt-3">
      <h3 className="text-sm font-semibold">الماستر (المصنّف)</h3>
      <p className="text-xs text-muted">
        اختار الموديل اللي بيحلل الطلبات. الموصى فيه ★. اضغط «افحص الموديلات» ليتصفّى الماستر لأقوى الموديلات اللي عندك (بدون المحلية).
      </p>
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
          // onClick too: with a filtered list the browser already shows the first option as selected, so clicking it fires no change event.
          <option key={o.value} value={o.value} onClick={() => o.value !== effective && void choose(o.value)}>
            {o.value === rec ? '★ ' : ''}
            {o.label}
            {badge(o)}
          </option>
        ))}
      </select>
      {anyQualified && (
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          عرض الكل {hidden > 0 && !showAll ? '(' + hidden + ' مخفي لأنو غير مؤهَّل)' : ''}
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button onClick={probe} disabled={busy || scanning} className="rounded bg-slate-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          جرّب الماستر المختار
        </button>
        <button onClick={run} disabled={busy || scanning} className="rounded bg-slate-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">
          اختبار الماستر (20 سؤال)
        </button>
        {scanning ? (
          <button onClick={cancelScan} className="rounded bg-red-700 px-3 py-1.5 text-sm text-white">
            إلغاء الفحص
          </button>
        ) : (
          <button onClick={scan} disabled={busy} className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">
            افحص الموديلات
          </button>
        )}
        {!scanning && (scanSt?.entries.length ?? 0) > 0 && (
          <button onClick={clearScan} className="rounded border border-outline px-3 py-1.5 text-sm">
            مسح نتائج الفحص
          </button>
        )}
      </div>
      {scanning && (
        <p className="text-xs">
          الفحص: {scanSt?.done}/{scanSt?.total} · {scanSt?.current}
        </p>
      )}
      {!scanning && scanSt && scanSt.at > 0 && (
        <div className="text-xs text-muted">
          <p>آخر فحص: {new Date(scanSt.at).toLocaleString('ar')}</p>
          <ul className="mt-1 space-y-0.5">
            {scanSt.entries.map((e) => (
              <li key={e.id}>
                {e.qualified ? '✓' : '✗'} {e.label} · {e.error ? e.error : e.parsed + '/20 مفهوم · ' + e.tools + '/20 أدوات · ' + e.avgMs + 'ms'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg && <pre className="mt-2 whitespace-pre-wrap text-xs">{msg}</pre>}
    </div>
  )
}
