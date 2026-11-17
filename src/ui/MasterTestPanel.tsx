import { useState } from 'react'

export function MasterTestPanel() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
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
    <div className="mt-4 border-t pt-3">
      <button onClick={run} disabled={busy} className="px-3 py-1.5 rounded bg-slate-700 text-white text-sm disabled:opacity-50">
        اختبار الماستر (Gemini 4 Carbon)
      </button>
      {msg && <pre className="text-xs whitespace-pre-wrap mt-2">{msg}</pre>}
    </div>
  )
}