// F28: side browser panel UI. The page itself is a native view drawn by the main process, below this toolbar.
// This component draws the toolbar (address bar + actions) and the drag handle, and reports width changes.
// 5.21.9: menu (open file, save page, zoom, font, reader mode, bookmark, import from Chrome/Edge/Brave) + address suggestions.
import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import { ArrowRight, BookOpen, Download, FolderOpen, Minus, MoreVertical, Plus, RotateCw, Save, Star, Trash2, X } from 'lucide-react'
import { askConfirm } from './components/confirm'
import { clampSideWidth } from '../core/side-url'
import { serviceForUrl } from '../core/side-partition'
import { FONT_CHOICES } from '../core/browser-import'

type SideState = { open: boolean; url: string | null; width: number; canGoBack: boolean }
type ViewInfo = Awaited<ReturnType<typeof window.api.side.viewInfo>>
type ImportSource = Awaited<ReturnType<typeof window.api.side.importList>>[number]
type Suggestion = { url: string; title: string; bookmark: boolean }

type Props = {
  width: number
  onWidthChange: (w: number) => void
  onClose: () => void
}

const EMPTY_INFO: ViewInfo = { open: false, host: '', zoom: 1, font: 'افتراضي', reader: false, bookmarked: false, local: false }

export function SideBrowserPanel({ width, onWidthChange, onClose }: Props): ReactElement {
  const [address, setAddress] = useState('')
  const [page, setPage] = useState<SideState>({ open: false, url: null, width, canGoBack: false })
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [menu, setMenu] = useState<null | 'menu' | 'import'>(null)
  const [info, setInfo] = useState<ViewInfo>(EMPTY_INFO)
  const [note, setNote] = useState<string | null>(null)
  const [sources, setSources] = useState<ImportSource[]>([])
  const [picked, setPicked] = useState<Record<string, { history: boolean; bookmarks: boolean }>>({})
  const [busy, setBusy] = useState(false)
  const [stats, setStats] = useState({ history: 0, bookmarks: 0, importedAt: 0 })
  const [sugs, setSugs] = useState<Suggestion[]>([])
  const [focused, setFocused] = useState(false)
  const sugSeq = useRef(0)

  // The main process pushes a state update on every navigation, so the toolbar never goes stale.
  useEffect(() => {
    void window.api.side.state().then((s) => {
      setPage(s)
      if (s.url) setAddress(s.url)
    })
    return window.api.side.onChanged((s) => {
      setPage(s)
      if (s.url) setAddress(s.url)
    })
  }, [])

  // The page is a native view, so DOM can't draw over it. While any popup, dialog, or approval is open,
  // the main process hides the page (kept loaded) so the popup is visible. Anything marked
  // data-side-overlay or aria-modal counts as a popup.
  useEffect(() => {
    let frame = 0
    let hidden = false
    const check = (): void => {
      frame = 0
      const open = document.querySelector('[data-side-overlay],[aria-modal="true"]') !== null
      if (open !== hidden) {
        hidden = open
        void window.api.side.setOverlay(open)
      }
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'data-side-overlay'] })
    check()
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      if (hidden) void window.api.side.setOverlay(false)
    }
  }, [])

  // Address suggestions: bookmarks first, then history. Only while typing in the field.
  useEffect(() => {
    const q = address.trim()
    if (!focused || q.length < 2 || q === page.url) return // stale suggestions stay hidden through showSugs below
    const seq = ++sugSeq.current
    const t = setTimeout(() => {
      void window.api.side.suggest(q).then((r) => {
        if (seq === sugSeq.current) setSugs(r)
      })
    }, 120)
    return () => clearTimeout(t)
  }, [address, focused, page.url])

  // A status note shown at the bottom of the panel fades after a few seconds.
  useEffect(() => {
    if (!note || menu) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note, menu])

  const typed = address.trim()
  const showSugs = sugs.length > 0 && focused && menu === null && typed.length >= 2 && typed !== page.url

  const go = async (value: string): Promise<void> => {
    const v = value.trim()
    if (!v) return
    const res = page.open ? await window.api.side.navigate(v) : await window.api.side.open(v)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setError(null)
    setSugs([])
    setFocused(false)
    setPage(await window.api.side.state())
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    await go(address)
  }

  const clearData = async (): Promise<void> => {
    // 5.21.8: إذا الصفحة المفتوحة لخدمة إلها جلسة خاصة (Designer، Canva...)، منمسح هي بس وباقي الحسابات بتضل مسجّلة.
    const svc = serviceForUrl(page.url ?? '')
    if (svc) {
      const host = svc.domains[0]
      const ok = await askConfirm(`تمسح بيانات ${host} بس؟ بتنمسح كوكيز وتسجيل دخول هالخدمة، وباقي الخدمات بتضل مسجّلة.`, { danger: true })
      if (ok) await window.api.side.clearService(svc.id)
      return
    }
    const ok = await askConfirm('تمسح بيانات المتصفح الجانبي كلها؟ بتنمسح الكوكيز وتسجيلات الدخول لكل المواقع والخدمات.', { danger: true })
    if (ok) await window.api.side.clearData()
  }

  const openMenu = async (): Promise<void> => {
    if (menu) {
      setMenu(null)
      return
    }
    setNote(null)
    setInfo(await window.api.side.viewInfo())
    setMenu('menu')
  }

  const openImport = async (): Promise<void> => {
    setNote(null)
    setMenu('import')
    const [list, st] = await Promise.all([window.api.side.importList(), window.api.side.libraryStats()])
    setSources(list)
    setStats(st)
    const init: Record<string, { history: boolean; bookmarks: boolean }> = {}
    for (const s of list) init[s.id] = { history: s.hasHistory, bookmarks: s.hasBookmarks }
    setPicked(init)
  }

  const act = async (fn: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>, okMsg?: string): Promise<void> => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (r.cancelled) return
    if (!r.ok) {
      setNote(r.error ?? 'صار خطأ')
      return
    }
    setMenu(null)
    if (okMsg) setNote(okMsg)
    setPage(await window.api.side.state())
  }

  const runImport = async (id: string): Promise<void> => {
    const p = picked[id]
    if (!p || (!p.history && !p.bookmarks)) return
    setBusy(true)
    const r = await window.api.side.importRun(id, p)
    setBusy(false)
    if (!r.ok) {
      setNote(r.error ?? 'فشل الاستيراد')
      return
    }
    setNote(`تم: ${r.history ?? 0} صفحة هيستوري و${r.bookmarks ?? 0} بوكمارك`)
    setStats(await window.api.side.libraryStats())
  }

  const clearLibrary = async (): Promise<void> => {
    const ok = await askConfirm('تمسح الهيستوري والبوكماركس يلي استوردتهم؟ ما بيتأثر المتصفح الأصلي.', { danger: true })
    if (!ok) return
    await window.api.side.libraryClear()
    setStats(await window.api.side.libraryStats())
    setNote('انمسحت المكتبة المستوردة')
  }

  // The panel sits at the left edge, so the width equals the pointer's x position.
  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const next = clampSideWidth(e.clientX)
    onWidthChange(next)
    void window.api.side.setWidth(next)
  }
  const onHandleUp = (): void => setDragging(false)

  const itemCls = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-surface2 disabled:opacity-40'
  const btnCls = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-surface2 disabled:opacity-40'

  return (
    <>
      <div className="fixed left-0 top-0 z-30 flex h-full flex-col border-e border-outline bg-surface" style={{ width }} dir="rtl">
        <div className="relative flex h-11 shrink-0 items-center gap-1 border-b border-outline px-2">
          <button onClick={() => void window.api.side.back().then(setPage)} disabled={!page.canGoBack} aria-label="رجوع" title="رجوع" className={btnCls}>
            <ArrowRight size={16} />
          </button>
          <button onClick={() => void window.api.side.reload()} disabled={!page.open} aria-label="تحديث" title="تحديث" className={btnCls}>
            <RotateCw size={15} />
          </button>
          <form onSubmit={submit} className="relative flex min-w-0 flex-1 items-center gap-1">
            <input
              dir="ltr"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value)
                setError(null)
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              placeholder="اكتب رابط…"
              aria-label="الرابط"
              aria-invalid={error ? true : undefined}
              className={`h-8 min-w-0 flex-1 rounded-full border bg-bg px-3 text-xs outline-none focus:border-primary ${error ? 'border-danger' : 'border-outline'}`}
            />
            {/* Errors live inside the toolbar: the native page view covers everything below it. */}
            {error && <span role="alert" className="max-w-[140px] shrink truncate text-xs text-danger">{error}</span>}
          </form>

          <button onClick={() => void openMenu()} aria-label="خيارات المتصفح" title="خيارات" aria-expanded={menu !== null} className={btnCls}>
            <MoreVertical size={16} />
          </button>
          <button onClick={() => void clearData()} aria-label="امسح بيانات المتصفح" title="امسح بيانات المتصفح" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface2 hover:text-danger">
            <Trash2 size={15} />
          </button>
          <button onClick={onClose} aria-label="سكّر المتصفح الجانبي" title="سكّر المتصفح الجانبي" className={btnCls}>
            <X size={15} />
          </button>
        </div>

        {/* Address suggestions. data-side-overlay hides the native page so this list is visible above it. */}
        {showSugs && (
          <ul data-side-overlay role="listbox" dir="ltr" className="absolute start-2 end-2 top-11 z-40 max-h-72 overflow-auto rounded-xl border border-outline bg-surface p-1 shadow-lg">
            {sugs.map((s) => (
              <li key={s.url} role="option" aria-selected={false}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setAddress(s.url)
                    void go(s.url)
                  }}
                  className="flex w-full flex-col rounded-lg px-3 py-1.5 text-start hover:bg-surface2"
                >
                  <span className="flex items-center gap-1 truncate text-xs">
                    {s.bookmark && <Star size={11} className="shrink-0 text-primary" />}
                    <span className="truncate">{s.title || s.url}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted">{s.url}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {menu && (
          <div data-side-overlay role="menu" className="absolute start-2 end-2 top-11 z-40 max-h-[80vh] overflow-auto rounded-xl border border-outline bg-surface p-2 shadow-lg">
            {menu === 'menu' && (
              <>
                <button className={itemCls} disabled={busy} onClick={() => void act(() => window.api.side.openFile())}>
                  <FolderOpen size={15} /> فتح ملف من الكمبيوتر
                </button>
                <div className="px-3 pt-2 text-[11px] text-muted">حفظ الصفحة</div>
                <div className="flex gap-1 px-2 pb-1">
                  {(['html', 'pdf', 'png'] as const).map((k) => (
                    <button key={k} disabled={busy || !info.open} onClick={() => void act(() => window.api.side.savePage(k), 'انحفظت الصفحة')} className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-outline py-1.5 text-xs hover:bg-surface2 disabled:opacity-40">
                      <Save size={12} /> {k.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div className="px-3 pt-2 text-[11px] text-muted">الحجم والخط ({Math.round(info.zoom * 100)}%{info.host ? ` · ${info.host}` : ''})</div>
                <div className="flex items-center gap-1 px-2 pb-1">
                  <button aria-label="تصغير" disabled={!info.open} onClick={() => void window.api.side.zoom(-1).then(setInfo)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-outline hover:bg-surface2 disabled:opacity-40"><Minus size={14} /></button>
                  <button disabled={!info.open} onClick={() => void window.api.side.zoom(0).then(setInfo)} className="h-8 flex-1 rounded-lg border border-outline text-xs hover:bg-surface2 disabled:opacity-40">100%</button>
                  <button aria-label="تكبير" disabled={!info.open} onClick={() => void window.api.side.zoom(1).then(setInfo)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-outline hover:bg-surface2 disabled:opacity-40"><Plus size={14} /></button>
                </div>
                <div className="px-2 pb-1">
                  <select aria-label="الخط" value={info.font} disabled={!info.open} onChange={(e) => void window.api.side.setFont(e.target.value).then(setInfo)} className="h-8 w-full rounded-lg border border-outline bg-bg px-2 text-xs disabled:opacity-40">
                    {FONT_CHOICES.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                </div>
                <button className={itemCls} disabled={!info.open} onClick={() => void window.api.side.toggleReader().then(setInfo)}>
                  <BookOpen size={15} /> وضع القراءة {info.reader ? '✓' : ''}
                </button>
                <button className={itemCls} disabled={!info.open || info.local} onClick={() => void window.api.side.toggleBookmark().then(setInfo)}>
                  <Star size={15} className={info.bookmarked ? 'text-primary' : ''} /> {info.bookmarked ? 'شيل من البوكماركس' : 'أضف للبوكماركس'}
                </button>
                <div className="my-1 border-t border-outline" />
                <button className={itemCls} onClick={() => void openImport()}>
                  <Download size={15} /> استيراد من متصفح تاني (Chrome / Edge / Brave)
                </button>
              </>
            )}

            {menu === 'import' && (
              <div className="space-y-2 p-1">
                <button className="text-xs text-primary" onClick={() => setMenu('menu')}>← رجوع</button>
                <p className="text-xs text-muted">
                  بنقرأ الهيستوري والبوكماركس بس، نسخة محلية. الكوكيز وكلمات السر ما بتنستورد (Chromium بيشفّرها). المتصفح الأصلي ما بيتغيّر.
                </p>
                {sources.length === 0 && <p className="text-xs">ما لقيت متصفحات مدعومة على هالجهاز.</p>}
                {sources.map((s) => (
                  <div key={s.id} className="rounded-lg border border-outline p-2">
                    <div className="mb-1 text-sm">{s.label} · {s.name}</div>
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1">
                        <input type="checkbox" disabled={!s.hasHistory} checked={picked[s.id]?.history ?? false} onChange={(e) => setPicked((p) => ({ ...p, [s.id]: { history: e.target.checked, bookmarks: p[s.id]?.bookmarks ?? false } }))} /> هيستوري
                      </label>
                      <label className="flex items-center gap-1">
                        <input type="checkbox" disabled={!s.hasBookmarks} checked={picked[s.id]?.bookmarks ?? false} onChange={(e) => setPicked((p) => ({ ...p, [s.id]: { history: p[s.id]?.history ?? false, bookmarks: e.target.checked } }))} /> بوكماركس
                      </label>
                      <button disabled={busy} onClick={() => void runImport(s.id)} className="ms-auto rounded-lg bg-primary px-3 py-1 text-xs text-white disabled:opacity-40">
                        {busy ? '…' : 'استورد'}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t border-outline pt-2 text-xs">
                  <span>المكتبة: {stats.history} هيستوري · {stats.bookmarks} بوكمارك</span>
                  <button onClick={() => void clearLibrary()} disabled={stats.history + stats.bookmarks === 0} className="text-danger disabled:opacity-40">امسح</button>
                </div>
              </div>
            )}

            {note && <p role="status" className="px-3 pt-2 text-xs text-primary">{note}</p>}
          </div>
        )}

        {!page.open && (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted">
            <p>اكتب رابط فوق واضغط Enter، والصفحة بتنفتح هون.</p>
          </div>
        )}
        {!menu && note && (
          <p role="status" className="absolute bottom-3 start-3 end-3 rounded-lg bg-surface2 px-3 py-2 text-xs">{note}</p>
        )}
      </div>

      {/* Drag handle on the panel's right edge. It sits just outside the native view, so it stays clickable. */}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        role="separator"
        aria-orientation="vertical"
        aria-label="اسحب لتغيير عرض المتصفح"
        className={`fixed top-0 z-40 h-full w-2 cursor-col-resize hover:bg-primary/30 ${dragging ? 'bg-primary/40' : ''}`}
        style={{ left: width }}
      />
    </>
  )
}
