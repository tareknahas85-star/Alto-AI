import { BrowserWindow, ipcMain, screen } from 'electron'

// أورب سعاد: دايرة شفافة صغيرة فوق كل الشبابيك (بدون ما تاخد ضغطات الماوس) بتبيّن حالة المحادثة الصوتية
// لما نافذة التطبيق مو قدامك: wake (عم تسمع الكلمة) / listen / think / speak.
type OrbState = '' | 'wake' | 'listen' | 'think' | 'speak'

const HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
.w{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.o{width:56px;height:56px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff8,#4f8cff 45%,#2447c8);box-shadow:0 0 24px #4f8cffaa;transition:all .25s}
.o.trust{box-shadow:0 0 0 4px #a855f7,0 0 30px #a855f7cc}
.o.wake{width:18px;height:18px;opacity:.55;box-shadow:0 0 10px #4f8cff88;animation:br 3s ease-in-out infinite}
.o.listen{background:radial-gradient(circle at 35% 30%,#fff8,#2ecc71 45%,#138a4a);box-shadow:0 0 28px #2ecc71aa;animation:pu 1.2s ease-in-out infinite}
.o.think{background:radial-gradient(circle at 35% 30%,#fff8,#f5a623 45%,#b36b00);box-shadow:0 0 28px #f5a623aa;animation:sp 1s linear infinite;border-radius:42%}
.o.speak{animation:pu .55s ease-in-out infinite;box-shadow:0 0 34px #4f8cffcc}
@keyframes pu{0%,100%{transform:scale(.9)}50%{transform:scale(1.15)}}
@keyframes br{0%,100%{opacity:.35}50%{opacity:.7}}
@keyframes sp{to{transform:rotate(360deg)}}
</style><div class="w"><div id="o" class="o wake"></div></div>
<script>window.setOrb=function(s){var e=document.getElementById('o');var t=e.classList.contains('trust');e.className='o '+s+(t?' trust':'')};window.setTrust=function(b){document.getElementById('o').classList.toggle('trust',b)}</script>`

let orb: BrowserWindow | null = null
let main: BrowserWindow | null = null
let state: OrbState = ''
let hooked = false
let trust = false

export function setOrbTrust(on: boolean): void {
  trust = on
  if (orb && !orb.isDestroyed() && !orb.webContents.isLoading()) void orb.webContents.executeJavaScript(`window.setTrust(${on})`).catch(() => undefined)
}

function ensure(): BrowserWindow {
  if (orb && !orb.isDestroyed()) return orb
  const wa = screen.getPrimaryDisplay().workArea
  const w = new BrowserWindow({
    width: 110, height: 110, x: wa.x + wa.width - 130, y: wa.y + wa.height - 130,
    transparent: true, frame: false, resizable: false, movable: false, skipTaskbar: true, focusable: false,
    alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  w.setAlwaysOnTop(true, 'screen-saver')
  w.setIgnoreMouseEvents(true)
  void w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  orb = w
  return w
}

function mainVisible(): boolean {
  return !!main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused()
}

function apply(): void {
  if (!state || mainVisible()) { if (orb && !orb.isDestroyed()) orb.hide(); return }
  const w = ensure()
  const run = (): void => { void w.webContents.executeJavaScript(`window.setOrb(${JSON.stringify(state)});window.setTrust(${trust})`).catch(() => undefined); w.showInactive() }
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', run)
  else run()
}

export function registerOrbIpc(): void {
  ipcMain.on('orb:state', (e, s: unknown) => {
    const st = (typeof s === 'string' && ['', 'wake', 'listen', 'think', 'speak'].includes(s) ? s : '') as OrbState
    state = st
    if (!hooked) {
      const m = BrowserWindow.fromWebContents(e.sender)
      if (m) {
        main = m
        hooked = true
        m.on('focus', apply)
        m.on('blur', apply)
        m.on('minimize', apply)
        m.on('restore', apply)
        m.on('show', apply)
        m.on('hide', apply)
        m.on('closed', () => { main = null; hooked = false; try { orb?.destroy() } catch { /* ignore */ } orb = null })
      }
    }
    apply()
  })
}
