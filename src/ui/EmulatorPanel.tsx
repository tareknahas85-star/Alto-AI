import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { H264Player } from './h264-player'

type Res<T = unknown> = { ok: boolean; data?: T; error?: string }
type Status = {
  connected: boolean
  serial?: string
  size?: { w: number; h: number }
  error?: string
}
type Api = {
  android: {
    status: () => Promise<Res<Status>>
    start: () => Promise<Res<boolean>>
    screenshot: () => Promise<Res<string>>
    tap: (x: number, y: number) => Promise<Res>
    swipe: (x1: number, y1: number, x2: number, y2: number, ms: number) => Promise<Res>
    key: (k: string) => Promise<Res>
    text: (t: string) => Promise<Res>
    streamStart: () => Promise<Res<boolean>>
    streamStop: () => Promise<Res>
    touch: (action: number, x: number, y: number) => void
    scroll: (x: number, y: number, dy: number) => void
    onVideo: (cb: (chunk: Uint8Array) => void) => () => void
    onVideoEnd: (cb: () => void) => () => void
  }
}

const api = (): Api['android'] => (window as unknown as { api: Api }).api.android

// Side panel with the live Android emulator. The screen is streamed into the panel itself,
// and mouse input goes straight to the device, so a drag is a real drag (shade, app drawer, scroll).
export function EmulatorPanel({
  width,
  onClose
}: {
  width: number
  onClose: () => void
}): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [starting, setStarting] = useState(false)
  const [mode, setMode] = useState<'video' | 'shot'>('shot')
  const [shot, setShot] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [text, setText] = useState('')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const pressed = useRef(false)
  const shotBusy = useRef(false)
  const lastWheel = useRef(0)

  const check = useCallback(async (): Promise<void> => {
    const r = await api().status()
    setStatus(r.ok && r.data ? r.data : { connected: false, error: r.error })
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async: setState runs after the await
    void check()
    const t = setInterval(() => {
      void check()
    }, 4000)
    return () => clearInterval(t)
  }, [check])

  // Live video: start the stream on the device, decode it into the canvas, stop it when the panel closes.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!status?.connected || !canvas) return
    const player = new H264Player(canvas)
    if (!player.supported) {
      player.close()
      setMsg('المتصفح ما بيدعم فك الفيديو')
      return
    }
    const offVideo = api().onVideo((chunk) => player.push(chunk))
    const offEnd = api().onVideoEnd(() => setMode('shot'))
    let alive = true
    void api()
      .streamStart()
      .then((r) => {
        if (!alive) return
        if (r.ok) setMode('video')
        else setMsg(r.error ?? 'تعذّر بث الشاشة')
      })
    return () => {
      alive = false
      offVideo()
      offEnd()
      void api().streamStop()
      player.close()
      setMode('shot')
    }
  }, [status?.connected])

  // Fallback when the live stream is not available: periodic screenshots.
  const refreshShot = useCallback(async (): Promise<void> => {
    if (shotBusy.current) return
    shotBusy.current = true
    try {
      const r = await api().screenshot()
      if (r.ok && r.data) setShot(r.data)
      else setMsg(r.error ?? 'خطأ')
    } finally {
      shotBusy.current = false
    }
  }, [])

  useEffect(() => {
    if (!status?.connected || mode !== 'shot') return
    void refreshShot()
    const t = setInterval(() => {
      void refreshShot()
    }, 1500)
    return () => clearInterval(t)
  }, [status?.connected, mode, refreshShot])

  const start = async (): Promise<void> => {
    setStarting(true)
    const r = await api().start()
    setStarting(false)
    setMsg(r.ok ? '' : (r.error ?? 'تعذّر التشغيل'))
    void check()
  }

  // Device coordinates for a point on the picture (the picture is scaled, so map by ratio).
  const toDevice = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = mode === 'video' ? canvasRef.current : imgRef.current
    if (!el || !status?.size) return null
    const rect = el.getBoundingClientRect()
    const x = Math.round((clientX - rect.left) * (status.size.w / rect.width))
    const y = Math.round((clientY - rect.top) * (status.size.h / rect.height))
    return {
      x: Math.min(status.size.w - 1, Math.max(0, x)),
      y: Math.min(status.size.h - 1, Math.max(0, y))
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>): void => {
    if (e.button !== 0 || mode !== 'video') return
    const p = toDevice(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pressed.current = true
    api().touch(0, p.x, p.y)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>): void => {
    if (!pressed.current) return
    const p = toDevice(e.clientX, e.clientY)
    if (p) api().touch(2, p.x, p.y)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLElement>): void => {
    if (!pressed.current) return
    pressed.current = false
    const p = toDevice(e.clientX, e.clientY)
    if (p) api().touch(1, p.x, p.y)
  }

  // Screenshot fallback: a click is a tap.
  const onShotClick = async (e: React.MouseEvent<HTMLImageElement>): Promise<void> => {
    const p = toDevice(e.clientX, e.clientY)
    if (!p) return
    const r = await api().tap(p.x, p.y)
    setMsg(r.ok ? '' : (r.error ?? 'خطأ'))
  }

  // Mouse wheel scrolls the screen: wheel down moves the content up.
  const onWheel = (e: React.WheelEvent<HTMLElement>): void => {
    if (mode !== 'video' || pressed.current || Math.abs(e.deltaY) < 4) return
    const now = Date.now()
    if (now - lastWheel.current < 40) return
    lastWheel.current = now
    const p = toDevice(e.clientX, e.clientY)
    if (p) api().scroll(p.x, p.y, e.deltaY)
  }

  const key = async (k: string): Promise<void> => {
    const r = await api().key(k)
    setMsg(r.ok ? '' : (r.error ?? 'خطأ'))
  }

  const send = async (): Promise<void> => {
    if (!text.trim()) return
    const r = await api().text(text.trim())
    setMsg(r.ok ? '' : (r.error ?? 'خطأ'))
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
          <span
            className={
              'inline-block h-2 w-2 rounded-full ' + (connected ? 'bg-green-500' : 'bg-gray-400')
            }
          />
          المحاكي (Android)
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void refreshShot()}
            disabled={!connected || mode === 'video'}
            className="rounded px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40"
          >
            تحديث
          </button>
          <button
            onClick={onClose}
            aria-label="إغلاق"
            className="rounded px-2 py-1 text-xs hover:bg-black/5"
          >
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
          <div className="flex flex-1 items-center justify-center overflow-hidden p-2">
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
              className={
                'max-h-full max-w-full touch-none select-none rounded-lg border bg-black ' +
                (mode === 'video' ? 'cursor-default' : 'hidden')
              }
              style={{ height: 'auto', width: 'auto', maxHeight: '100%' }}
            />
            {mode === 'shot' &&
              (shot ? (
                <img
                  ref={imgRef}
                  src={shot}
                  alt="شاشة المحاكي"
                  onClick={(e) => void onShotClick(e)}
                  onDragStart={(e) => e.preventDefault()}
                  draggable={false}
                  className="max-h-full max-w-full cursor-default select-none rounded-lg border"
                />
              ) : (
                <p className="text-sm text-gray-500">جاري تحميل الشاشة...</p>
              ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-outline p-2">
            <button
              onClick={() => void key('BACK')}
              className="rounded-md border px-2 py-1 text-xs"
            >
              رجوع
            </button>
            <button
              onClick={() => void key('HOME')}
              className="rounded-md border px-2 py-1 text-xs"
            >
              الرئيسية
            </button>
            <button
              onClick={() => void key('RECENTS')}
              className="rounded-md border px-2 py-1 text-xs"
            >
              الأخيرة
            </button>
          </div>
          <div className="flex gap-2 border-t border-outline p-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="نص (إنكليزي وأرقام)"
              dir="ltr"
              className="min-w-0 flex-1 rounded-md border px-2 py-1 text-xs"
            />
            <button onClick={() => void send()} className="rounded-md border px-2 py-1 text-xs">
              إرسال
            </button>
          </div>
          {msg && <p className="px-3 pb-2 text-xs text-red-500">{msg}</p>}
        </>
      )}
    </aside>
  )
}
