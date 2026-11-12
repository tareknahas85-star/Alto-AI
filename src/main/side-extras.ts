// 5.21.9: extras for the side browser panel. Open a local file, save the page (HTML / PDF / screenshot), per-site zoom + font +
// reader mode, and an OPTIONAL import of history and bookmarks from Chrome / Edge / Brave / Chromium.
// Only History and Bookmarks are ever read from another browser. Cookies and saved passwords are never touched.
import { app, dialog, type BrowserWindow, type WebContents } from 'electron'
import { promises as fsp } from 'node:fs'
import { join, extname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openSideFile, setSidePageHook, sideWebContents, sideState } from './side-browser'
import {
  browserRoots, chromiumTimeToMs, clampZoom, DEFAULT_PREFS, fontCss, isProfileDir, keepHttp, mergeBookmarks, mergeHistory,
  parseBookmarks, READER_CSS, sanitizePrefs, stepZoom, suggest,
  type BrowserKind, type LibBookmark, type LibItem, type Suggestion, type ViewPrefs
} from '../core/browser-import'

type Library = { history: LibItem[]; bookmarks: LibBookmark[]; importedAt: number }
export type ImportSource = { id: string; browser: BrowserKind; label: string; profile: string; name: string; hasHistory: boolean; hasBookmarks: boolean }
export type ViewInfo = ViewPrefs & { open: boolean; host: string; bookmarked: boolean; local: boolean }
type Result = { ok: true; message?: string } | { ok: false; error: string }

const libFile = (): string => join(app.getPath('userData'), 'side-library.json')
const prefsFile = (): string => join(app.getPath('userData'), 'side-prefs.json')

let lib: Library | null = null
let prefs: Record<string, ViewPrefs> | null = null

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) as T } catch { return fallback }
}

async function getLib(): Promise<Library> {
  if (lib) return lib
  const raw = await readJson<Partial<Library>>(libFile(), {})
  lib = {
    history: Array.isArray(raw.history) ? raw.history.filter((h) => keepHttp(h?.url)) : [],
    bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks.filter((b) => keepHttp(b?.url)) : [],
    importedAt: typeof raw.importedAt === 'number' ? raw.importedAt : 0
  }
  return lib
}
const saveLib = async (): Promise<void> => { if (lib) await fsp.writeFile(libFile(), JSON.stringify(lib), 'utf8') }

async function getPrefs(): Promise<Record<string, ViewPrefs>> {
  if (prefs) return prefs
  const raw = await readJson<Record<string, unknown>>(prefsFile(), {})
  prefs = {}
  for (const [k, v] of Object.entries(raw)) prefs[k] = sanitizePrefs(v)
  return prefs
}
const savePrefs = async (): Promise<void> => { if (prefs) await fsp.writeFile(prefsFile(), JSON.stringify(prefs), 'utf8') }

function hostKey(url: string): string {
  if (/^file:/i.test(url)) return 'local-file'
  try { return new URL(url).hostname.toLowerCase() || 'unknown' } catch { return 'unknown' }
}

// ---- zoom / font / reader ----
const cssKeys = new WeakMap<WebContents, { font?: string; reader?: string }>()

async function syncCss(wc: WebContents, p: ViewPrefs): Promise<void> {
  const k = cssKeys.get(wc) ?? {}
  try {
    if (k.font) { await wc.removeInsertedCSS(k.font).catch(() => undefined); k.font = undefined }
    if (k.reader) { await wc.removeInsertedCSS(k.reader).catch(() => undefined); k.reader = undefined }
    const f = fontCss(p.font)
    if (f) k.font = await wc.insertCSS(f)
    if (p.reader) k.reader = await wc.insertCSS(READER_CSS)
  } catch { /* the page went away mid-way: nothing to style */ }
  cssKeys.set(wc, k)
}

async function applyPrefs(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return
  const p = (await getPrefs())[hostKey(wc.getURL())] ?? DEFAULT_PREFS
  wc.setZoomFactor(p.zoom)
  await syncCss(wc, p)
}

async function changePrefs(mutate: (p: ViewPrefs) => ViewPrefs): Promise<ViewInfo> {
  const wc = sideWebContents()
  if (!wc || wc.isDestroyed()) return viewInfo()
  const all = await getPrefs()
  const key = hostKey(wc.getURL())
  const next = sanitizePrefs(mutate(all[key] ?? DEFAULT_PREFS))
  if (next.zoom === 1 && next.font === DEFAULT_PREFS.font && !next.reader) delete all[key]
  else all[key] = next
  await savePrefs()
  wc.setZoomFactor(next.zoom)
  await syncCss(wc, next)
  return viewInfo()
}

export const setZoom = (dir: 1 | -1 | 0): Promise<ViewInfo> => changePrefs((p) => ({ ...p, zoom: stepZoom(p.zoom, dir) }))
export const setFont = (font: string): Promise<ViewInfo> => changePrefs((p) => ({ ...p, font }))
export const toggleReader = (): Promise<ViewInfo> => changePrefs((p) => ({ ...p, reader: !p.reader }))

export async function viewInfo(): Promise<ViewInfo> {
  const wc = sideWebContents()
  const st = sideState()
  if (!wc || wc.isDestroyed() || !st.open) return { ...DEFAULT_PREFS, open: false, host: '', bookmarked: false, local: false }
  const url = wc.getURL()
  const key = hostKey(url)
  const p = (await getPrefs())[key] ?? DEFAULT_PREFS
  const l = await getLib()
  return { ...p, zoom: clampZoom(p.zoom), open: true, host: key, bookmarked: l.bookmarks.some((b) => b.url === url), local: key === 'local-file' }
}

export function initSideExtras(): void {
  setSidePageHook((wc) => { cssKeys.delete(wc); void applyPrefs(wc) })
}

// ---- open file / save page ----
const OPEN_EXT = ['html', 'htm', 'xhtml', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'txt', 'md', 'json', 'csv', 'log', 'xml']

export async function openLocalFile(win: BrowserWindow): Promise<Result & { cancelled?: boolean }> {
  const r = await dialog.showOpenDialog(win, {
    title: 'افتح ملف بالمتصفح الجانبي',
    properties: ['openFile'],
    filters: [{ name: 'ملفات بتنعرض (صفحات، PDF، صور، نصوص)', extensions: OPEN_EXT }]
  })
  if (r.canceled || !r.filePaths[0]) return { ok: true, cancelled: true }
  const file = r.filePaths[0]
  const ext = extname(file).slice(1).toLowerCase()
  if (!OPEN_EXT.includes(ext)) return { ok: false, error: 'هالنوع من الملفات ما بينفتح بالمتصفح الجانبي' }
  const res = openSideFile(win, pathToFileURL(file).href)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export type SaveKind = 'html' | 'pdf' | 'png'

export async function savePage(win: BrowserWindow, kind: SaveKind): Promise<Result & { cancelled?: boolean; path?: string }> {
  const wc = sideWebContents()
  if (!wc || wc.isDestroyed() || !sideState().open) return { ok: false, error: 'ما في صفحة مفتوحة لتنحفظ' }
  const label = kind === 'html' ? 'صفحة ويب' : kind === 'pdf' ? 'PDF' : 'صورة PNG'
  const title = (wc.getTitle() || hostKey(wc.getURL())).replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 80) || 'page'
  const r = await dialog.showSaveDialog(win, {
    title: 'احفظ الصفحة',
    defaultPath: join(app.getPath('documents'), `${title}.${kind}`),
    filters: [{ name: label, extensions: [kind] }]
  })
  if (r.canceled || !r.filePath) return { ok: true, cancelled: true }
  try {
    if (kind === 'html') await wc.savePage(r.filePath, 'HTMLComplete')
    else if (kind === 'pdf') await fsp.writeFile(r.filePath, await wc.printToPDF({ printBackground: true }))
    else await fsp.writeFile(r.filePath, (await wc.capturePage()).toPNG())
    return { ok: true, path: r.filePath }
  } catch (e) {
    return { ok: false, error: 'ما قدرت أحفظ الصفحة: ' + (e instanceof Error ? e.message : String(e)) }
  }
}

// ---- optional import from other browsers (history + bookmarks only) ----
async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

export async function listImportSources(): Promise<ImportSource[]> {
  const out: ImportSource[] = []
  for (const r of browserRoots(process.platform, process.env, homedir(), join)) {
    if (!(await exists(r.root))) continue
    const state = await readJson<{ profile?: { info_cache?: Record<string, { name?: string }> } }>(join(r.root, 'Local State'), {})
    let dirs: string[] = []
    try { dirs = (await fsp.readdir(r.root, { withFileTypes: true })).filter((d) => d.isDirectory() && isProfileDir(d.name)).map((d) => d.name) } catch { continue }
    for (const d of dirs.sort()) {
      const hasHistory = await exists(join(r.root, d, 'History'))
      const hasBookmarks = await exists(join(r.root, d, 'Bookmarks'))
      if (!hasHistory && !hasBookmarks) continue
      out.push({ id: `${r.browser}|${d}`, browser: r.browser, label: r.label, profile: d, name: state.profile?.info_cache?.[d]?.name || d, hasHistory, hasBookmarks })
    }
  }
  return out
}

function readHistoryDb(file: string, src: string): LibItem[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('SELECT url, title, (last_visit_time / 1000) AS lv, visit_count AS vc FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 8000').all() as Array<{ url: string; title: string; lv: number; vc: number }>
    const items: LibItem[] = []
    for (const r of rows) {
      if (!keepHttp(r.url)) continue
      items.push({ url: r.url, title: String(r.title ?? '').slice(0, 200), t: chromiumTimeToMs(Number(r.lv) * 1000), visits: Number(r.vc) || 1, src })
    }
    return items
  } finally {
    db.close()
  }
}

export async function importFrom(id: string, what: { history: boolean; bookmarks: boolean }): Promise<Result & { history?: number; bookmarks?: number }> {
  if (!what.history && !what.bookmarks) return { ok: false, error: 'اختار شي تستورده' }
  const src = (await listImportSources()).find((s) => s.id === id)
  if (!src) return { ok: false, error: 'ما لقيت هالمتصفح أو البروفايل' }
  const root = browserRoots(process.platform, process.env, homedir(), join).find((r) => r.browser === src.browser)?.root
  if (!root) return { ok: false, error: 'ما لقيت مجلد المتصفح' }
  const l = await getLib()
  let h = 0
  let b = 0
  const tag = `${src.label}:${src.name}`
  if (what.history && src.hasHistory) {
    const tmp = join(tmpdir(), `alto-hist-${process.pid}-${Date.now()}.db`)
    try {
      await fsp.copyFile(join(root, src.profile, 'History'), tmp)
      const items = readHistoryDb(tmp, tag)
      l.history = mergeHistory(l.history, items)
      h = items.length
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      const busy = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      return { ok: false, error: busy ? `${src.label} شغّال وقافل ملف الهيستوري. سكّرو وجرّب مرة تانية.` : 'ما قدرت أقرا الهيستوري: ' + (e instanceof Error ? e.message : String(e)) }
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
    }
  }
  if (what.bookmarks && src.hasBookmarks) {
    try {
      const json = JSON.parse(await fsp.readFile(join(root, src.profile, 'Bookmarks'), 'utf8')) as unknown
      const items = parseBookmarks(json, tag)
      l.bookmarks = mergeBookmarks(l.bookmarks, items)
      b = items.length
    } catch (e) {
      return { ok: false, error: 'ما قدرت أقرا الإشارات المرجعية: ' + (e instanceof Error ? e.message : String(e)) }
    }
  }
  l.importedAt = Date.now()
  await saveLib()
  return { ok: true, history: h, bookmarks: b }
}

export async function librarySuggest(q: string): Promise<Suggestion[]> {
  const l = await getLib()
  return suggest(typeof q === 'string' ? q.slice(0, 200) : '', l.history, l.bookmarks, 8)
}

export async function libraryStats(): Promise<{ history: number; bookmarks: number; importedAt: number }> {
  const l = await getLib()
  return { history: l.history.length, bookmarks: l.bookmarks.length, importedAt: l.importedAt }
}

export async function libraryClear(): Promise<boolean> {
  lib = { history: [], bookmarks: [], importedAt: 0 }
  await saveLib()
  return true
}

export async function toggleBookmark(): Promise<ViewInfo> {
  const wc = sideWebContents()
  if (!wc || wc.isDestroyed()) return viewInfo()
  const url = wc.getURL()
  if (!keepHttp(url)) return viewInfo()
  const l = await getLib()
  const i = l.bookmarks.findIndex((x) => x.url === url)
  if (i >= 0) l.bookmarks.splice(i, 1)
  else l.bookmarks.unshift({ url, title: (wc.getTitle() || hostKey(url)).slice(0, 200), folder: '', src: 'Alto' })
  await saveLib()
  return viewInfo()
}
