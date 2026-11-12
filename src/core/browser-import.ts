// 5.21.9: pure helpers for the side browser's extras: importing history/bookmarks from other Chromium browsers,
// address-bar suggestions, and per-site zoom/font/reader prefs. No Electron, no fs: everything here is unit-testable.

export type LibItem = { url: string; title: string; t: number; visits: number; src: string }
export type LibBookmark = { url: string; title: string; folder: string; src: string }
export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'chromium'
export type BrowserRoot = { browser: BrowserKind; label: string; root: string }
export type ViewPrefs = { zoom: number; font: string; reader: boolean }

export const MAX_HISTORY = 5000
export const MAX_BOOKMARKS = 3000

/** Chromium stores times as microseconds since 1601-01-01. */
export function chromiumTimeToMs(t: number): number {
  if (!Number.isFinite(t) || t <= 0) return 0
  return Math.round(t / 1000 - 11644473600000)
}

export function keepHttp(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password
  } catch {
    return false
  }
}

type JoinFn = (...parts: string[]) => string

/** Where each Chromium browser keeps its profiles on this OS (only history/bookmarks are ever read from there). */
export function browserRoots(platform: string, env: Record<string, string | undefined>, home: string, join: JoinFn): BrowserRoot[] {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [
      { browser: 'chrome', label: 'Chrome', root: join(base, 'Google', 'Chrome', 'User Data') },
      { browser: 'edge', label: 'Edge', root: join(base, 'Microsoft', 'Edge', 'User Data') },
      { browser: 'brave', label: 'Brave', root: join(base, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { browser: 'chromium', label: 'Chromium', root: join(base, 'Chromium', 'User Data') }
    ]
  }
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return [
      { browser: 'chrome', label: 'Chrome', root: join(base, 'Google', 'Chrome') },
      { browser: 'edge', label: 'Edge', root: join(base, 'Microsoft Edge') },
      { browser: 'brave', label: 'Brave', root: join(base, 'BraveSoftware', 'Brave-Browser') },
      { browser: 'chromium', label: 'Chromium', root: join(base, 'Chromium') }
    ]
  }
  const base = env.XDG_CONFIG_HOME || join(home, '.config')
  return [
    { browser: 'chrome', label: 'Chrome', root: join(base, 'google-chrome') },
    { browser: 'edge', label: 'Edge', root: join(base, 'microsoft-edge') },
    { browser: 'brave', label: 'Brave', root: join(base, 'BraveSoftware', 'Brave-Browser') },
    { browser: 'chromium', label: 'Chromium', root: join(base, 'chromium') }
  ]
}

/** Profile folder names Chromium uses: "Default" and "Profile 1", "Profile 2"... */
export const isProfileDir = (name: string): boolean => name === 'Default' || /^Profile \d+$/.test(name)

type BookmarkNode = { type?: string; name?: string; url?: string; children?: BookmarkNode[] }

/** Flattens a Chromium "Bookmarks" JSON file into {url,title,folder}. */
export function parseBookmarks(json: unknown, src: string): LibBookmark[] {
  const out: LibBookmark[] = []
  const roots = (json as { roots?: Record<string, BookmarkNode> } | null)?.roots
  if (!roots || typeof roots !== 'object') return out
  const walk = (node: BookmarkNode, folder: string): void => {
    if (out.length >= MAX_BOOKMARKS) return
    if (node.type === 'url' && keepHttp(node.url)) {
      out.push({ url: node.url, title: String(node.name ?? '').slice(0, 200), folder, src })
      return
    }
    const here = node.name ? (folder ? folder + ' / ' + node.name : node.name) : folder
    for (const c of node.children ?? []) walk(c, here)
  }
  for (const key of ['bookmark_bar', 'other', 'synced']) {
    const r = roots[key]
    if (r && typeof r === 'object') walk(r, '')
  }
  return out
}

export function mergeHistory(existing: LibItem[], incoming: LibItem[], max = MAX_HISTORY): LibItem[] {
  const map = new Map<string, LibItem>()
  for (const it of [...existing, ...incoming]) {
    const cur = map.get(it.url)
    if (!cur) { map.set(it.url, { ...it }); continue }
    map.set(it.url, { url: it.url, title: it.t >= cur.t && it.title ? it.title : cur.title, t: Math.max(it.t, cur.t), visits: Math.max(it.visits, cur.visits), src: cur.src })
  }
  return [...map.values()].sort((a, b) => b.t - a.t).slice(0, max)
}

export function mergeBookmarks(existing: LibBookmark[], incoming: LibBookmark[], max = MAX_BOOKMARKS): LibBookmark[] {
  const seen = new Set<string>()
  const out: LibBookmark[] = []
  for (const b of [...existing, ...incoming]) {
    if (seen.has(b.url)) continue
    seen.add(b.url)
    out.push(b)
  }
  return out.slice(0, max)
}

export type Suggestion = { url: string; title: string; bookmark: boolean }

/** Address-bar suggestions: bookmarks first, then history by how often/recently it was visited. An empty query lists bookmarks. */
export function suggest(query: string, history: LibItem[], bookmarks: LibBookmark[], limit = 8): Suggestion[] {
  const q = (query ?? '').trim().toLowerCase()
  const out: Suggestion[] = []
  const seen = new Set<string>()
  const add = (url: string, title: string, bookmark: boolean): void => {
    if (seen.has(url) || out.length >= limit) return
    seen.add(url)
    out.push({ url, title, bookmark })
  }
  const hit = (url: string, title: string): boolean => !q || url.toLowerCase().includes(q) || title.toLowerCase().includes(q)
  for (const b of bookmarks) if (hit(b.url, b.title)) add(b.url, b.title, true)
  if (!q) return out
  const marked = new Set(bookmarks.map((b) => b.url))
  const rest = history.filter((h) => hit(h.url, h.title)).sort((a, b) => b.visits * 3 + b.t / 1e11 - (a.visits * 3 + a.t / 1e11))
  for (const h of rest) add(h.url, h.title, marked.has(h.url))
  return out
}

// ---- zoom / font / reader ----
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 3
export const clampZoom = (z: number): number => (Number.isFinite(z) ? Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100 : 1)
export const stepZoom = (z: number, dir: 1 | -1 | 0): number => (dir === 0 ? 1 : clampZoom(z + dir * 0.1))

export const FONT_CHOICES = ['افتراضي', 'Segoe UI', 'Tahoma', 'Arial', 'Verdana', 'Times New Roman', 'Georgia', 'Consolas']

export const DEFAULT_PREFS: ViewPrefs = { zoom: 1, font: 'افتراضي', reader: false }

export function sanitizePrefs(p: unknown): ViewPrefs {
  const o = (p ?? {}) as Partial<ViewPrefs>
  return {
    zoom: clampZoom(typeof o.zoom === 'number' ? o.zoom : 1),
    font: typeof o.font === 'string' && FONT_CHOICES.includes(o.font) ? o.font : 'افتراضي',
    reader: o.reader === true
  }
}

/** CSS that swaps the page font without breaking icon fonts or code blocks. Empty for the default font. */
export function fontCss(font: string): string {
  if (!FONT_CHOICES.includes(font) || font === 'افتراضي') return ''
  const safe = font.replace(/[^A-Za-z ]/g, '')
  const skip = ':not(i):not(svg):not(code):not(pre):not(kbd):not(samp):not([class*="icon" i]):not([class*="material" i]):not([class*="glyph" i]):not([class*="fa-"]):not([class^="fa"])'
  return `body, body *${skip} { font-family: "${safe}", "Segoe UI", Tahoma, sans-serif !important; }`
}

/** Reader mode: hides page chrome and sets a calm, wide-leading, centered column. */
export const READER_CSS = `
header, nav, footer, aside, [role="banner"], [role="navigation"], [role="complementary"], [role="contentinfo"],
[class*="cookie" i], [class*="newsletter" i], [class*="advert" i], [id*="advert" i], [class*="sidebar" i], [id*="sidebar" i] { display: none !important; }
html { background: #fbfaf6 !important; }
body { max-width: 760px !important; margin: 0 auto !important; padding: 24px 20px !important; background: #fbfaf6 !important; color: #222 !important; line-height: 1.85 !important; font-size: 18px !important; }
body * { max-width: 100% !important; box-sizing: border-box; }
img, video { height: auto !important; }
a { color: #0b5cad !important; }
`