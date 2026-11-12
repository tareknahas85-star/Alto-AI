// F28: side browser panel. A WebContentsView attached to the main window, on its own isolated session.
// Layout: the panel sits on the LEFT edge, below a TOOLBAR_HEIGHT strip that the renderer draws (address bar).
// The window widens to fit the panel. While a popup/approval is open, the page is detached so the popup shows on top.
// Hardening (see spec): no preload, no IPC access, no contextIsolation bypass, permissions denied,
// downloads blocked, external popups opened in the system browser, http(s) only.
import { WebContentsView, session, shell, screen, type BrowserWindow } from 'electron'
import { checkSideUrl, clampSideWidth, windowWidthFor } from '../core/side-url'
import { SIDE_DEFAULT_PARTITION, SIDE_SERVICES, partitionForUrl, partitionOfService, serviceForUrl } from '../core/side-partition'

// Which session the open page uses: one per media service, a shared default for everything else.
let partition = SIDE_DEFAULT_PARTITION
// Agent-driven browsing uses its own throw-away session (no 'persist:' prefix = memory only), never the user's sign-ins.
const AGENT_PARTITION = 'agent-browser'
let agentMode = false
// 5.21.9: a file the user picked from disk opens in its own throw-away session; it can never reach the signed-in sessions.
const LOCAL_PARTITION = 'side-local'
let localMode = false
// Lets the extras module (zoom / font / reader) re-apply its settings every time a page finishes parsing.
let pageHook: ((wc: Electron.WebContents) => void) | null = null
export function setSidePageHook(fn: (wc: Electron.WebContents) => void): void { pageHook = fn }
export const sideWebContents = (): Electron.WebContents | null => (view ? view.webContents : null)
export const sideIsAgent = (): boolean => agentMode
// Must match the height of the toolbar the renderer draws (h-11 = 44px).
export const TOOLBAR_HEIGHT = 44

export type SideState = { open: boolean; url: string | null; width: number; canGoBack: boolean }

let view: WebContentsView | null = null
let attachedTo: BrowserWindow | null = null
let width = 420
let currentUrl: string | null = null
const hardened = new Set<string>()
const migrated = new Set<string>()
// True while a popup/approval is open: the page is detached (kept alive) so the popup can draw over it.
let overlayHidden = false
// Window content width before the panel widened it. Restored when the panel closes.
let widthBeforeSide: number | null = null

function hardenSession(p: string): void {
  if (hardened.has(p)) return
  hardened.add(p)
  const sess = session.fromPartition(p)
  // Every permission (camera, mic, location, notifications, ...) is refused.
  sess.setPermissionRequestHandler((_wc, _perm, callback) => callback(false))
  sess.setPermissionCheckHandler(() => false)
  // Downloads are off in v1.
  sess.on('will-download', (event) => event.preventDefault())
  keepSessionCookies(sess)
}

// 5.21.9: sign-ins stay until the user clears them by hand. Many sites (Microsoft included) hand out cookies with no expiry,
// which Chromium drops on quit; give those a one-year expiry so they are written to disk. Only the trash button removes them.
const KEEP_SECONDS = 365 * 24 * 3600
function keepSessionCookies(sess: Electron.Session): void {
  const store = sess.cookies
  const keep = (c: Electron.Cookie): void => {
    if (c.session !== true && c.expirationDate) return
    const host = (c.domain ?? '').replace(/^\./, '')
    if (!host) return
    void store.set({
      url: `https://${host}${c.path}`,
      name: c.name, value: c.value,
      ...(c.hostOnly ? {} : { domain: c.domain }),
      path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      expirationDate: Math.floor(Date.now() / 1000) + KEEP_SECONDS
    }).catch(() => { /* e.g. a __Host- cookie that can't be re-set: leave it as is */ })
  }
  store.on('changed', (_e, c, _cause, removed) => { if (!removed) keep(c) })
  void store.get({}).then((all) => all.forEach(keep)).catch(() => undefined)
}

function createView(): WebContentsView {
  hardenSession(partition)
  const v = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  })

  const wc = v.webContents
  // Only http(s) may navigate; anything else (file:, custom schemes) is cancelled.
  wc.on('will-navigate', (event, url) => {
    if (!checkSideUrl(url).ok) event.preventDefault()
  })
  wc.on('will-redirect', (event, url) => {
    if (!checkSideUrl(url).ok) event.preventDefault()
  })
  // New windows never open inside the panel; safe links go to the system browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (checkSideUrl(url).ok) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('did-navigate', (_e, url) => {
    currentUrl = url
    notifyChanged()
  })
  wc.on('did-navigate-in-page', (_e, url) => {
    currentUrl = url
    notifyChanged()
  })
  wc.on('dom-ready', () => { if (!agentMode) pageHook?.(wc) })
  return v
}

// Tells the renderer the panel state changed (page navigated, went back, etc.).
function notifyChanged(): void {
  if (attachedTo && !attachedTo.isDestroyed()) attachedTo.webContents.send('side:changed', sideState())
}

// Grows the window so the sidebar, the chat, and the panel all fit on screen (never shrinks it).
function fitWindow(win: BrowserWindow): void {
  if (win.isMaximized() || win.isFullScreen()) return
  const area = screen.getDisplayMatching(win.getBounds()).workArea
  const current = win.getContentBounds().width
  const target = windowWidthFor(current, width, area.width)
  if (target === current) return
  // Remember the width from before the first expansion, so closing the panel can restore it.
  if (widthBeforeSide === null) widthBeforeSide = current
  win.setContentSize(target, win.getContentBounds().height)
  // If the window now runs past the right edge of the screen, slide it left.
  const b = win.getBounds()
  const maxX = area.x + area.width - b.width
  if (b.x > maxX) win.setPosition(Math.max(area.x, maxX), b.y)
}

function layout(win: BrowserWindow): void {
  if (!view) return
  fitWindow(win)
  const { height: totalH } = win.getContentBounds()
  width = clampSideWidth(width)
  view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, totalH - TOOLBAR_HEIGHT) })
}

function detachFrom(win: BrowserWindow): void {
  if (view && !overlayHidden) win.contentView.removeChildView(view)
}

function ensureAttached(win: BrowserWindow): void {
  if (!view) view = createView()
  if (attachedTo !== win) {
    if (attachedTo) detachFrom(attachedTo)
    attachedTo = win
    if (!overlayHidden) win.contentView.addChildView(view)
  }
  layout(win)
}

// First time a service gets its own session: bring over its cookies from the old shared one so nobody has to sign in again.
async function migrateOnce(p: string): Promise<void> {
  if (p === SIDE_DEFAULT_PARTITION || migrated.has(p)) return
  migrated.add(p)
  const svc = SIDE_SERVICES.find((x) => partitionOfService(x.id) === p)
  if (!svc) return
  try {
    const from = session.fromPartition(SIDE_DEFAULT_PARTITION).cookies
    const to = session.fromPartition(p).cookies
    if ((await to.get({})).length > 0) return
    for (const c of await from.get({})) {
      const d = (c.domain ?? '').replace(/^\./, '').toLowerCase()
      if (!svc.domains.some((x) => d === x || d.endsWith('.' + x))) continue
      try {
        await to.set({
          url: (c.secure ? 'https' : 'http') + '://' + d + (c.path || '/'), name: c.name, value: c.value,
          domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite
        })
      } catch { /* skip a cookie that can't be copied */ }
    }
  } catch { /* migration is best-effort */ }
}

// Switches the panel to the session that belongs to this address (recreates the page view when it differs).
function switchPartition(win: BrowserWindow, url: string): void {
  const p = agentMode ? AGENT_PARTITION : localMode ? LOCAL_PARTITION : partitionForUrl(url)
  if (view && p !== partition) {
    if (!overlayHidden) { try { win.contentView.removeChildView(view) } catch { /* ignore */ } }
    view.webContents.close()
    view = null
    attachedTo = null
  }
  partition = p
}

function loadIn(url: string): void {
  const p = partition
  const v = view
  void migrateOnce(p).then(() => { if (view === v && v) return v.webContents.loadURL(url).catch(() => undefined); return undefined })
}

/** The agent opens a page in the visible panel, in its own temporary session. */
export async function agentBrowse(win: BrowserWindow, url: string): Promise<{ ok: true; url: string; title: string } | { ok: false; error: string }> {
  const checked = checkSideUrl(url)
  if (!checked.ok) return { ok: false, error: checked.reason }
  agentMode = true
  switchPartition(win, checked.url)
  ensureAttached(win)
  currentUrl = checked.url
  // The model opened the page, not the user: tell the renderer now so it reserves room for the panel and draws its toolbar.
  notifyChanged()
  const wc = view!.webContents
  await new Promise<void>((res) => {
    let done = false
    const f = (): void => { if (!done) { done = true; res() } }
    wc.once('did-finish-load', f)
    wc.on('did-fail-load', (_e, _c, _d, _u, main) => { if (main) f() })
    void wc.loadURL(checked.url).catch(f)
    setTimeout(f, 20000)
  })
  return { ok: true, url: wc.getURL(), title: wc.getTitle() }
}

export const agentWebContents = (): Electron.WebContents | null => (agentMode && view ? view.webContents : null)

export async function agentCloseBrowser(): Promise<void> {
  if (!agentMode) return
  const win = attachedTo
  closeSide()
  // closeSide() clears the attached window first, so tell the renderer directly that the panel is gone.
  if (win && !win.isDestroyed()) win.webContents.send('side:changed', sideState())
  const sess = session.fromPartition(AGENT_PARTITION)
  await sess.clearStorageData()
  await sess.clearCache()
}

export function openSide(win: BrowserWindow, rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  const checked = checkSideUrl(rawUrl)
  if (!checked.ok) return { ok: false, error: checked.reason }
  agentMode = false
  localMode = false
  switchPartition(win, checked.url)
  ensureAttached(win)
  currentUrl = checked.url
  loadIn(checked.url)
  return { ok: true, url: checked.url }
}

/** 5.21.9: opens a local file (already approved by the user through the system file dialog) in the panel. */
export function openSideFile(win: BrowserWindow, fileUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  if (!/^file:\/\//i.test(fileUrl)) return { ok: false, error: 'مسار الملف مو صالح' }
  agentMode = false
  localMode = true
  switchPartition(win, fileUrl)
  ensureAttached(win)
  currentUrl = fileUrl
  notifyChanged()
  void view!.webContents.loadURL(fileUrl).catch(() => undefined)
  return { ok: true, url: fileUrl }
}

export function navigateSide(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  if (!view) return { ok: false, error: 'المتصفح الجانبي مغلق' }
  const checked = checkSideUrl(rawUrl)
  if (!checked.ok) return { ok: false, error: checked.reason }
  currentUrl = checked.url
  agentMode = false
  localMode = false
  const win = attachedTo
  if (win && !win.isDestroyed() && partitionForUrl(checked.url) !== partition) {
    switchPartition(win, checked.url)
    ensureAttached(win)
  }
  loadIn(checked.url)
  return { ok: true, url: checked.url }
}

export function backSide(): SideState {
  if (view && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack()
  return sideState()
}

export function reloadSide(): SideState {
  if (view) view.webContents.reload()
  return sideState()
}

export function setSideWidth(w: number): SideState {
  width = w
  if (attachedTo && view) layout(attachedTo)
  return sideState()
}

// Called by the renderer when a popup/approval opens or closes. Hiding keeps the page loaded.
export function setSideOverlay(on: boolean): SideState {
  overlayHidden = on
  if (!view || !attachedTo || attachedTo.isDestroyed()) return sideState()
  if (on) {
    attachedTo.contentView.removeChildView(view)
  } else {
    attachedTo.contentView.addChildView(view)
    layout(attachedTo)
  }
  return sideState()
}

export function closeSide(): SideState {
  const win = attachedTo
  if (win && view) detachFrom(win)
  // Put the window back to the width it had before the panel widened it.
  if (win && !win.isDestroyed() && widthBeforeSide !== null && !win.isMaximized() && !win.isFullScreen()) {
    win.setContentSize(widthBeforeSide, win.getContentBounds().height)
  }
  widthBeforeSide = null
  attachedTo = null
  overlayHidden = false
  if (view) {
    view.webContents.close()
    view = null
  }
  currentUrl = null
  agentMode = false
  localMode = false
  return sideState()
}

// Keeps the panel sized to the window when the window is resized.
export function onWindowResized(win: BrowserWindow): void {
  if (attachedTo === win) layout(win)
}

export async function clearSideData(): Promise<void> {
  for (const p of [SIDE_DEFAULT_PARTITION, ...SIDE_SERVICES.map((x) => partitionOfService(x.id))]) {
    const sess = session.fromPartition(p)
    await sess.clearStorageData()
    await sess.clearCache()
  }
}

/** Wipes one service's session only (cookies, storage, cache); the other sites stay signed in. */
export async function clearSideService(id: string): Promise<boolean> {
  const svc = SIDE_SERVICES.find((x) => x.id === id)
  if (!svc) return false
  const sess = session.fromPartition(partitionOfService(svc.id))
  await sess.clearStorageData()
  await sess.clearCache()
  migrated.add(partitionOfService(svc.id)) // don't re-import old cookies after an explicit clear
  if (view && serviceForUrl(currentUrl ?? '')?.id === svc.id) closeSide()
  return true
}

export function sideState(): SideState {
  return {
    open: view !== null && attachedTo !== null,
    url: currentUrl,
    width,
    canGoBack: view !== null && view.webContents.navigationHistory.canGoBack()
  }
}
