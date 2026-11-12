import { ipcMain, type WebContents } from 'electron'
import WebSocket from 'ws'
import { getApiKey } from '../store/secure-store'
import { parseLiveAll } from '../core/live-voice'
import { isTranslateLang, translateSetup } from '../core/live-translate'

// ترجمة فورية بـ Gemini Live: الـmain بيحمل الـWebSocket والمفتاح (ما بيوصل للواجهة)، والواجهة بتبعت/بتستقبل صوت PCM عبر IPC.
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'

let ws: WebSocket | null = null
let sender: WebContents | null = null

function emit(ev: Record<string, unknown>): void {
  try { sender?.send('translate:event', ev) } catch { /* window closed */ }
}

function closeSession(): void {
  const w = ws
  ws = null
  try { w?.close() } catch { /* ignore */ }
}

export function registerTranslateIpc(): void {
  ipcMain.handle('translate:available', () => !!getApiKey('GEMINI_API_KEY'))

  ipcMain.handle('translate:start', async (e, target: unknown, echo: unknown) => {
    const key = getApiKey('GEMINI_API_KEY')
    if (!key) return { ok: false, error: 'ما في مفتاح Gemini محفوظ (إعدادات ← المفاتيح)' }
    if (!isTranslateLang(target)) return { ok: false, error: 'لغة الهدف مو مدعومة' }
    closeSession()
    sender = e.sender
    try {
      const sock = new WebSocket(WS_URL + '?key=' + encodeURIComponent(key))
      ws = sock
      await new Promise<void>((resolve, reject) => {
        let up = false
        const t = setTimeout(() => reject(new Error('انتهى الوقت وانا عم وصل بموديل الترجمة')), 15000)
        sock.on('open', () => sock.send(JSON.stringify(translateSetup(target, echo === true))))
        sock.on('message', (data) => {
          for (const ev of parseLiveAll(data.toString())) {
            if (ev.type === 'ready') { up = true; clearTimeout(t); resolve(); continue }
            if (ev.type === 'ignore' || ev.type === 'toolCall') continue
            emit(ev as unknown as Record<string, unknown>)
          }
        })
        sock.on('error', (err) => {
          clearTimeout(t)
          // the URL carries the key, so never forward the raw error text
          if (!up) reject(new Error('تعذّر الاتصال بموديل الترجمة'))
          else emit({ type: 'error', error: 'انقطع الاتصال' })
          void err
        })
        sock.on('close', (code, reason) => {
          clearTimeout(t)
          if (!up) { reject(new Error('انسكرت الجلسة ' + code + ' ' + reason.toString().slice(0, 160))); return }
          if (ws === sock) { ws = null; emit({ type: 'closed', code, reason: reason.toString().slice(0, 160) }) }
        })
      })
      return { ok: true }
    } catch (err) {
      closeSession()
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  })

  ipcMain.on('translate:audio', (_e, b64: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || typeof b64 !== 'string' || b64.length > 200000) return
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }))
  })

  ipcMain.handle('translate:stop', () => { closeSession(); return true })
}