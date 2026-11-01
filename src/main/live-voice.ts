import { app, ipcMain, type WebContents } from 'electron'
import fsp from 'fs/promises'
import path from 'path'
import WebSocket from 'ws'
import { getApiKey } from '../store/secure-store'
import { pickLiveModel, liveSetup, parseLiveAll, type LiveModelInfo } from '../core/live-voice'

// محادثة صوتية مباشرة عبر Gemini Live (أونلاين، بمفتاح Gemini تبع المستخدم).
// الـmain بيحمل الـWebSocket والمفتاح، والواجهة بس بتبعت/بتستقبل صوت PCM عبر IPC.

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const cfgPath = (): string => path.join(app.getPath('userData'), 'voice-live.json')

interface LiveCfg { model?: string; voice?: string }
async function readCfg(): Promise<LiveCfg> {
  try { return JSON.parse(await fsp.readFile(cfgPath(), 'utf8')) as LiveCfg } catch { return {} }
}

let cachedModel: LiveModelInfo | null = null
async function resolveModel(key: string, forced?: string): Promise<LiveModelInfo> {
  if (forced) return { name: forced.startsWith('models/') ? forced : 'models/' + forced, label: forced }
  if (cachedModel) return cachedModel
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' + encodeURIComponent(key))
  if (!r.ok) throw new Error('تعذّر جلب لائحة الموديلات (' + r.status + ')')
  const j = (await r.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] }
  const picked = pickLiveModel(j.models ?? [])
  if (!picked) throw new Error('مفتاح Gemini ما عندو موديل صوت مباشر (Live)')
  cachedModel = picked
  return picked
}

let ws: WebSocket | null = null
let sender: WebContents | null = null

function emit(ev: Record<string, unknown>): void {
  try { sender?.send('live:event', ev) } catch { /* window closed */ }
}

function closeLive(): void {
  const w = ws
  ws = null
  try { w?.close() } catch { /* ignore */ }
}

export function registerLiveIpc(): void {
  ipcMain.handle('live:start', async (e) => {
    const key = getApiKey('GEMINI_API_KEY')
    if (!key) return { ok: false, error: 'ما في مفتاح Gemini محفوظ (إعدادات ← المفاتيح)' }
    closeLive()
    sender = e.sender
    try {
      const cfg = await readCfg()
      const model = await resolveModel(key, cfg.model)
      const sock = new WebSocket(WS_URL + '?key=' + encodeURIComponent(key))
      ws = sock
      await new Promise<void>((resolve, reject) => {
        let up = false
        const t = setTimeout(() => reject(new Error('انتهى الوقت وانا عم وصل بـGemini Live')), 15000)
        sock.on('open', () => sock.send(JSON.stringify(liveSetup(model.name, cfg.voice))))
        sock.on('message', (data) => {
          for (const ev of parseLiveAll(data.toString())) {
            if (ev.type === 'ready') { up = true; clearTimeout(t); resolve(); continue }
            if (ev.type !== 'ignore') emit(ev as unknown as Record<string, unknown>)
          }
        })
        sock.on('error', (err) => { clearTimeout(t); if (!up) reject(err as Error); else emit({ type: 'error', error: String((err as Error).message ?? err) }) })
        sock.on('close', (code, reason) => {
          clearTimeout(t)
          if (!up) { reject(new Error('انسكرت الجلسة ' + code + ' ' + reason.toString())); return }
          if (ws === sock) { ws = null; emit({ type: 'closed', code, reason: reason.toString() }) }
        })
      })
      return { ok: true, model: model.label }
    } catch (err) {
      closeLive()
      return { ok: false, error: String((err as Error).message ?? err) }
    }
  })

  ipcMain.on('live:audio', (_e, b64: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || typeof b64 !== 'string') return
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }))
  })

  ipcMain.handle('live:stop', () => { closeLive(); return true })
  ipcMain.handle('live:available', () => !!getApiKey('GEMINI_API_KEY'))
}
