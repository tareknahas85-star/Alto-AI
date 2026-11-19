import { ipcMain, type WebContents } from 'electron'
import WebSocket from 'ws'
import { getApiKey } from '../store/secure-store'
import { parseLiveAll } from '../core/live-voice'
import { isTranslateLang, translateSetup, TRANSLATE_LANGS } from '../core/live-translate'

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
  // ترجمة نص ملصوق (بدون صوت): Gemini عبر REST، المفتاح بالهيدر مو بالرابط.
  ipcMain.handle('translate:text', async (_e, text: unknown, target: unknown) => {
    const key = getApiKey('GEMINI_API_KEY')
    if (!key) return { ok: false, error: 'ما في مفتاح Gemini محفوظ (إعدادات ← المفاتيح)' }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'الصق نص أول' }
    if (!isTranslateLang(target)) return { ok: false, error: 'لغة الهدف مو مدعومة' }
    const lang = TRANSLATE_LANGS.find((l) => l.code === target)?.label ?? String(target)
    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Translate the following text to ' + lang + '. Output only the translation, no notes, keep the formatting.\n\n' + text.slice(0, 20000) }] }] }),
        signal: AbortSignal.timeout(60000)
      })
      if (!res.ok) return { ok: false, error: 'Gemini رجّع ' + res.status }
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      const out = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim()
      return out ? { ok: true, text: out } : { ok: false, error: 'رد فاضي من موديل الترجمة' }
    } catch (e) {
      return { ok: false, error: 'تعذّر الاتصال: ' + (e instanceof Error ? e.message : String(e)).slice(0, 100) }
    }
  })
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
        const t = setTimeout(() => reject(new Error('انتهى الوقت وانا عم وصل بموديل الترجمة (الصوت الفوري). جرّب تبويب «نص» فوق للصق نص.')), 25000)
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