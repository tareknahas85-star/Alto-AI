// F28: IPC handlers for the side browser. Every handler runs behind the F11 sender guard (set up in index.ts),
// so only the app's own renderer can call them. Arguments are type-checked here (F12).
import { ipcMain, type BrowserWindow } from 'electron'
import { initSideExtras, openLocalFile, savePage, setZoom, setFont, toggleReader, viewInfo, listImportSources, importFrom, librarySuggest, libraryStats, libraryClear, toggleBookmark } from './side-extras'
import { openSide, navigateSide, closeSide, setSideWidth, setSideOverlay, clearSideData, clearSideService, backSide, reloadSide, sideState } from './side-browser'

export function registerSideIpc(getWin: () => BrowserWindow | null): void {
  initSideExtras()
  const withWin = (fn: (win: BrowserWindow) => unknown): unknown => {
    const win = getWin()
    if (!win || win.isDestroyed()) return { ok: false, error: 'النافذة الرئيسية مش متاحة' }
    return fn(win)
  }

  ipcMain.handle('side:open', (_e, url: unknown) => {
    if (typeof url !== 'string') return { ok: false, error: 'قيمة مو صالحة' }
    return withWin((win) => openSide(win, url))
  })

  ipcMain.handle('side:navigate', (_e, url: unknown) => {
    if (typeof url !== 'string') return { ok: false, error: 'قيمة مو صالحة' }
    return navigateSide(url)
  })

  ipcMain.handle('side:back', () => backSide())
  ipcMain.handle('side:reload', () => reloadSide())
  ipcMain.handle('side:close', () => closeSide())

  ipcMain.handle('side:setWidth', (_e, w: unknown) => {
    if (typeof w !== 'number' || !Number.isFinite(w)) return sideState()
    return setSideWidth(w)
  })

  ipcMain.handle('side:setOverlay', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return sideState()
    return setSideOverlay(on)
  })

  ipcMain.handle('side:clearData', async () => {
    await clearSideData()
    return true
  })

  ipcMain.handle('side:clearService', async (_e, id: unknown) => (typeof id === 'string' ? clearSideService(id) : false))

  ipcMain.handle('side:state', () => sideState())

  // 5.21.9: open a file, save the page, zoom/font/reader, optional import of history + bookmarks from other browsers.
  ipcMain.handle('side:openFile', () => withWin((win) => openLocalFile(win)))
  ipcMain.handle('side:savePage', (_e, kind: unknown) => {
    if (kind !== 'html' && kind !== 'pdf' && kind !== 'png') return { ok: false, error: 'نوع الحفظ مو صالح' }
    return withWin((win) => savePage(win, kind))
  })
  ipcMain.handle('side:viewInfo', () => viewInfo())
  ipcMain.handle('side:zoom', (_e, dir: unknown) => setZoom(dir === 1 ? 1 : dir === -1 ? -1 : 0))
  ipcMain.handle('side:font', (_e, font: unknown) => (typeof font === 'string' ? setFont(font) : viewInfo()))
  ipcMain.handle('side:reader', () => toggleReader())
  ipcMain.handle('side:bookmarkToggle', () => toggleBookmark())
  ipcMain.handle('side:importList', () => listImportSources())
  ipcMain.handle('side:importRun', (_e, id: unknown, what: unknown) => {
    const w = (what ?? {}) as { history?: unknown; bookmarks?: unknown }
    if (typeof id !== 'string') return { ok: false, error: 'قيمة مو صالحة' }
    return importFrom(id, { history: w.history === true, bookmarks: w.bookmarks === true })
  })
  ipcMain.handle('side:suggest', (_e, q: unknown) => librarySuggest(typeof q === 'string' ? q : ''))
  ipcMain.handle('side:libraryStats', () => libraryStats())
  ipcMain.handle('side:libraryClear', () => libraryClear())
}
