import { useEffect, useRef, useState, type ReactElement } from 'react'
import { TRANSLATE_LANGS } from '../core/live-translate'
import { startTranslate } from './translate-audio'

const field = 'rounded-lg border border-outline bg-bg px-3 py-1.5 outline-none focus:border-primary'

export function TranslatePage(): ReactElement {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [target, setTarget] = useState('ar')
  const [echo, setEcho] = useState(false)
  const [speak, setSpeak] = useState(true)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [msg, setMsg] = useState('')
  const [orig, setOrig] = useState('')
  const [trans, setTrans] = useState('')
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let off = false
    void window.api.translate.available().then((v) => { if (!off) setHasKey(v) })
    return () => { off = true; stopRef.current?.() }
  }, [])

  const stop = (): void => {
    stopRef.current?.()
    stopRef.current = null
    setRunning(false)
    setSpeaking(false)
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    const r = await startTranslate(target, echo, speak, {
      onOriginal: (t) => setOrig((o) => (o + t).slice(-4000)),
      onTranslated: (t) => setTrans((o) => (o + t).slice(-4000)),
      onSpeaking: setSpeaking,
      onClose: (m) => { setMsg(m); stopRef.current?.(); stopRef.current = null; setRunning(false); setSpeaking(false) }
    })
    setBusy(false)
    if (!r.ok) { setMsg(r.error ?? 'ما اشتغلت'); return }
    stopRef.current = r.stop
    setRunning(true)
  }

  const copy = (t: string): void => { void navigator.clipboard.writeText(t).catch(() => undefined) }

  return (
    <div className="h-full overflow-y-auto p-6" dir="rtl">
      <h2 className="text-lg font-semibold">ترجمة فورية</h2>
      <p className="mt-1 text-xs text-muted">
        احكي بأي لغة وبتسمع الترجمة لحظة بلحظة، ومعها نص الأصل ونص الترجمة. بتستعمل موديل الترجمة تبع Gemini بمفتاحك (إعدادات ← المفاتيح).
      </p>

      <section className="mt-4 rounded-card border border-outline bg-surface p-4 shadow-card">
        {hasKey === false && <p className="mb-3 text-xs text-danger">ما في مفتاح Gemini محفوظ. حطّو من الإعدادات أول شي.</p>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            ترجم إلى
            <select className={field} value={target} disabled={running || busy} onChange={(e) => setTarget(e.target.value)}>
              {TRANSLATE_LANGS.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={speak} disabled={running || busy} onChange={(e) => setSpeak(e.target.checked)} />
            شغّل الصوت المترجم
          </label>
          <label className="flex items-center gap-1 text-xs" title="إذا الكلام أصلاً باللغة الهدف، بيعيدو بدل ما يسكت">
            <input type="checkbox" checked={echo} disabled={running || busy} onChange={(e) => setEcho(e.target.checked)} />
            كرّر الكلام اللي هو أصلاً باللغة الهدف
          </label>
          {running ? (
            <button onClick={stop} className="rounded-full bg-danger px-4 py-1.5 text-white">⏹ وقّف</button>
          ) : (
            <button disabled={busy || hasKey === false} onClick={() => void start()} className="rounded-full bg-primary px-4 py-1.5 text-white disabled:opacity-50">
              {busy ? 'عم وصّل…' : '🎙 ابدأ'}
            </button>
          )}
          {running && <span className="text-xs text-muted">{speaking ? '🔊 عم بترجم…' : '👂 عم بسمع…'}</span>}
        </div>
        <p className="mt-2 text-xs text-muted">لا تشغّل الصوت المترجم على سماعات الجهاز نفسو والمايك مفتوح، لأن المايك بيلتقطو. الأفضل سماعة رأس.</p>
        {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}
      </section>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {[
          { title: 'الأصل', text: orig, clear: () => setOrig('') },
          { title: 'الترجمة', text: trans, clear: () => setTrans('') }
        ].map((b) => (
          <section key={b.title} className="rounded-card border border-outline bg-surface p-4 shadow-card">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">{b.title}</h3>
              <div className="flex gap-2 text-xs">
                <button disabled={!b.text} onClick={() => copy(b.text)} className="rounded-full border border-outline px-3 py-1 hover:bg-surface2 disabled:opacity-50">نسخ</button>
                <button disabled={!b.text} onClick={b.clear} className="rounded-full border border-outline px-3 py-1 hover:bg-surface2 disabled:opacity-50">مسح</button>
              </div>
            </div>
            <p className="mt-2 min-h-24 whitespace-pre-wrap text-sm">{b.text || <span className="text-muted">لسا ما في كلام.</span>}</p>
          </section>
        ))}
      </div>
    </div>
  )
}