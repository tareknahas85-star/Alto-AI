import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

type Res<T = unknown> = { ok: boolean; data?: T; error?: string }
type Status = { connected: boolean; serial?: string; size?: { w: number; h: number }; error?: string }
type Api = {
  android: {
    status: () => Promise<Res<Status>>
    start: () => Promise<Res<boolean>>
    screenshot: () => Promise<Res<string>>
    tap: (x: number, y: number) => Promise<Res>
    key: (k: string) => Promise<Res>
    text: (t: string) => Promise<Res>
  }
}

const api = (): Api['android'] => (window as unknown as { api: Api }).api.android

// Side panel with the live Android emulator, same place as the side browser.
export function EmulatorPanel({ width, onClose }: { width: number; onClose: () => void }): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [starting, setStarting] = useState(false)
  const [shot, setShot] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [msg, setMsg] = useState('')
  const [text, setText] = useState('')
  const imgRef = useRef<HTMLImageElement | null>(null)

  const check = useCallback(async (): Promise<void> => {
    const r = await api().status()
    setStatus(r.ok && r.data ? r.data : { connected: false, error: r.error })
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const r = await api().screenshot()
    if (r.ok && r.data) {
      setShot(r.data)
      setMsg('')
    } else setMsg(r.error ?? 'خطأ')
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async: setState runs after the await
    void check()
    const t = setInterval(() => { void check() }, 4000)
    return () => clearInterval(t)
  }, [check])

  useEffect(() => {
    if (!status?.connected) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async: setState runs after the await
    void refresh()
    if (!auto) return
    const t = setInterval(() => { void refresh() }, 1500)
    return () => clearInterval(t)
  }, [status?.connected, auto, refresh])

  const start = async (): Promise<void> => {
    setStarting(true)
    const r = await api().start()
    setStarting(false)
    setMsg(r.ok ? '' : r.error ?? 'تعذّر التشغيل')
    void check()
  }

  const onImgClick = async (e: React.MouseEvent<HTMLImageElement>): Promise<void> => {
    const img = imgRef.current
    if (!img || !status?.size) return
    const rect = img.getBoundingClientRect()
    const x = Math.round((e.clientX - rect.left) * (status.size.w / rect.width))
    const y = Math.round((e.clientY - rect.top) * (status.size.h / rect.height))
    const r = await api().tap(x, y)
    setMsg(r.ok ? '' : r.error ?? 'خطأ')
    if (r.ok) setTimeout(() => { void refresh() }, 600)
  }

  const key = async (k: string): Promise<void> => {
    const r = await api().key(k)
    setMsg(r.ok ? '' : r.error ?? 'خطأ')
    if (r.ok) setTimeout(() => { void refresh() }, 600)
  }

  const send = async (): Promise<void> => {
    if (!text.trim()) return
    const r = await api().text(text.trim())
    setMsg(r.ok ? '' : r.error ?? 'خطأ')
    if (r.ok) setText('')
  }

  const connected = !!status?.connected

  return (
    <aside
      dir="rtl"
      className="fixed left-0 top-0 z-30 flex h-full flex-col border-l border-outline bg-surface"
      style={{ width }}
    >
      <div className="flex h-11 items-center justify-between gap-2 border-b border-outline px-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className={'inline-block h-2 w-2 rounded-full ' + (connected ? 'bg-green-500' : 'bg-gray-400')} />
          المحاكي (Android)
        </div>
        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={!connected} />
            تلقائي
          </label>
          <button onClick={() => void refresh()} disabled={!connected} className="rounded px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40">
            تحديث
          </button>
          <button onClick={onClose} aria-label="إغلاق" className="rounded px-2 py-1 text-xs hover:bg-black/5">
            ✕
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-gray-500">
          <p>{starting ? 'جاري تشغيل المحاكي... (أول مرة بتاخد دقايق)' : 'المحاكي مو شغّال.'}</p>
          {!starting && (
            <button onClick={() => void start()} className="rounded-md border px-3 py-1">
              تشغيل المحاكي
            </button>
          )}
          {status?.error && !starting && <p className="text-xs text-gray-400">{status.error}</p>}
        </div>
      ) : (
        <>
          <div className="flex flex-1 items-center justify-center overflow-auto p-2">
            {shot ? (
              <img
                ref={imgRef}
                src={shot}
                alt="شاشة المحاكي"
                onClick={(e) => void onImgClick(e)}
                className="max-h-full max-w-full cursor-pointer rounded-lg border"
              />
            ) : (
              <p className="text-sm text-gray-500">جاري تحميل الشاشة...</p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-outline p-2">
            <button onClick={() => void key('BACK')} className="rounded-md border px-2 py-1 text-xs">رجوع</button>
            <button onClick={() => void key('HOME')} className="rounded-md border px-2 py-1 text-xs">الرئيسية</button>
            <button onClick={() => void key('RECENTS')} className="rounded-md border px-2 py-1 text-xs">الأخيرة</button>
          </div>
          <div className="flex gap-2 border-t border-outline p-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="نص (إنكليزي وأرقام)"
              dir="ltr"
              className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs"
            />
            <button onClick={() => void send()} className="rounded-md border px-2 py-1 text-xs">إرسال</button>
          </div>
          {msg && <p className="px-3 pb-2 text-xs text-red-500">{msg}</p>}
        </>
      )}
    </aside>
  )
}
