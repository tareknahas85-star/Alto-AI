import { app, ipcMain } from 'electron'
import { execFile } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { transcribeLive, warmWhisper } from './whisper-live'
import { cleanForSpeech, pickVoice, splitSegments, VOICE_AR, VOICE_EN, SPEECH_RATE } from '../core/voice'

// Read-aloud: edge-tts (free, no key; needs internet) with the Syrian voice; falls back to the Windows voice when it can't run.
const run = (cmd: string, args: string[], ms: number): Promise<{ ok: boolean; err: string }> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true }, (e, _o, se) => resolve({ ok: !e, err: e ? (se || e.message).toString().slice(-300) : '' }))
  })

/** سطر تشخيص بملف router.log (بدون نصوص أو مفاتيح). */
export function vlog(msg: string): void {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'router.log'), new Date().toISOString() + ' voice :: ' + msg.replace(/\s+/g, ' ').slice(0, 220) + '\n') } catch { /* ignore */ }
}

async function edgeTts(text: string, voice: string, out: string): Promise<string> {
  let last = ''
  for (const py of ['python', 'py']) {
    const args = (py === 'py' ? ['-3'] : []).concat(['-m', 'edge_tts', '--voice', voice, '--rate=' + SPEECH_RATE, '--text', text, '--write-media', out])
    let r = await run(py, args, 60000)
    if (!r.ok && /NoAudioReceived/i.test(r.err)) { await new Promise((res) => setTimeout(res, 700)); r = await run(py, args, 60000) }
    if (!r.ok && /No module named/i.test(r.err)) {
      const inst = await run(py, (py === 'py' ? ['-3'] : []).concat(['-m', 'pip', 'install', 'edge-tts']), 120000)
      if (inst.ok) r = await run(py, args, 60000)
    }
    if (r.ok) return ''
    last = r.err
  }
  return last || 'python غير موجود'
}

async function windowsVoice(text: string, out: string): Promise<string> {
  const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $v=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -like '${/[؀-ۿ]/.test(text) ? 'ar*' : 'en*'}'}|Select-Object -First 1; if($v){$s.SelectVoice($v.VoiceInfo.Name)} elseif($env:TRL_AR -eq '1'){ throw 'ما في صوت عربي مثبّت بويندوز' }; $s.SetOutputToWaveFile($env:TRL_OUT); $s.Speak($env:TRL_TEXT); $s.Dispose()`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 60000, windowsHide: true, env: { ...process.env, TRL_OUT: out, TRL_TEXT: text, TRL_AR: /[\u0600-\u06FF]/.test(text) ? '1' : '0' } }, (e) => resolve(e ? e.message : ''))
  })
}

const cfgPath = (): string => path.join(app.getPath('userData'), 'voice.json')
async function arVoice(): Promise<string> {
  try {
    const j = JSON.parse(await fsp.readFile(cfgPath(), 'utf8')) as { voice?: string }
    if (j.voice && /^ar-[A-Z]{2}-[A-Za-z]+Neural$/.test(j.voice)) return j.voice
  } catch { /* default */ }
  return VOICE_AR
}

// Arabic and English runs are spoken by separate voices and glued together (mp3 frames concatenate fine).
async function edgeSegments(text: string, out: string): Promise<string> {
  const ar = await arVoice()
  const segs = splitSegments(text)
  if (!segs.length) return 'ما في نص يتقرأ'
  // all segments are synthesized in parallel (each is a separate edge-tts call), then glued in order
  const errs = await Promise.all(segs.map((sg, i) => edgeTts(sg.text, sg.lang === 'en' ? VOICE_EN : ar, out + '.' + i)))
  const bad = errs.find((e) => e)
  if (bad) { segs.forEach((_s, i) => fsp.rm(out + '.' + i, { force: true }).catch(() => undefined)); return bad }
  const bufs: Buffer[] = []
  for (let i = 0; i < segs.length; i++) {
    bufs.push(await fsp.readFile(out + '.' + i))
    fsp.rm(out + '.' + i, { force: true }).catch(() => undefined)
  }
  await fsp.writeFile(out, Buffer.concat(bufs))
  return ''
}

/** Dialogue / long text to one mp3 buffer: each line gets its own voice; Latin runs get the English voice; 4 edge-tts calls at a time. */
export async function synthDialogue(lines: { text: string; voice: string }[]): Promise<Buffer> {
  const jobs: { text: string; voice: string }[][] = lines.map((l) => {
    const t = cleanForSpeech(l.text)
    return splitSegments(t).map((sg) => ({ text: sg.text, voice: sg.lang === 'en' ? VOICE_EN : l.voice }))
  })
  const flat = jobs.flat()
  const base = path.join(os.tmpdir(), 'trl-dlg-' + Date.now())
  const bufs: Buffer[] = new Array(flat.length)
  let next = 0
  let fail = ''
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (!fail) {
        const i = next++
        if (i >= flat.length) return
        const f = base + '.' + i
        const err = await edgeTts(flat[i].text, flat[i].voice, f)
        if (err) { fail = err; return }
        bufs[i] = await fsp.readFile(f)
        fsp.rm(f, { force: true }).catch(() => undefined)
      }
    })
  )
  if (fail) throw new Error('توليد الصوت فشل: ' + fail.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 120))
  return Buffer.concat(bufs)
}

// قراءة بصوت سعاد على دفعات: أول جملة بتجهز بسرعة والباقي بيجي وإنت عم تسمع (كل دفعة بتنطلب بـvoice:suaadNext).
type SpeechSession = { it: AsyncGenerator<{ mime: string; buf: Buffer }>; ts: number }
const speechSessions = new Map<string, SpeechSession>()

async function nextSpeech(id: string, ms: number): Promise<{ ok: boolean; id?: string; url?: string; done?: boolean; error?: string }> {
  const s = speechSessions.get(id)
  if (!s) return { ok: false, error: 'الجلسة انتهت' }
  let timer: NodeJS.Timeout | undefined
  try {
    const r = await Promise.race([
      s.it.next(),
      new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(new Error('انتهى الوقت')), ms) }),
    ])
    if (r.done) { speechSessions.delete(id); return { ok: true, done: true } }
    return { ok: true, id, url: `data:${r.value.mime};base64,${r.value.buf.toString('base64')}` }
  } catch (e) {
    speechSessions.delete(id)
    vlog('suaad part failed: ' + (e as Error).message)
    return { ok: false, error: (e as Error).message }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function registerVoiceIpc(): void {
  ipcMain.handle('voice:suaadStart', async (_e, raw: unknown) => {
    if (typeof raw !== 'string') return { ok: false, error: 'نص مو صالح' }
    const text = cleanForSpeech(raw)
    if (!text) return { ok: false, error: 'ما في نص يتقرأ' }
    for (const [k, v] of speechSessions) if (Date.now() - v.ts > 600000) speechSessions.delete(k)
    try {
      const { suaadSpeak } = await import('./suaad-voice')
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      speechSessions.set(id, { it: suaadSpeak(text, () => !speechSessions.has(id), { rewrite: false }), ts: Date.now() })
      const t0 = Date.now()
      const r = await nextSpeech(id, 60000)
      vlog('suaad first part ' + (r.ok ? 'ok' : 'FAILED') + ' in ' + (Date.now() - t0) + 'ms')
      return r
    } catch (e) {
      vlog('suaad start failed: ' + (e as Error).message)
      return { ok: false, error: (e as Error).message }
    }
  })
  ipcMain.handle('voice:suaadNext', (_e, id: unknown) => (typeof id === 'string' ? nextSpeech(id, 120000) : { ok: false, error: 'id' }))
  ipcMain.handle('voice:suaadStop', (_e, id: unknown) => { if (typeof id === 'string') speechSessions.delete(id); return true })
  ipcMain.handle('voice:warm', () => { warmWhisper(); return true })
  ipcMain.handle('voice:transcribe', async (_e, data: unknown) => {
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return { ok: false, error: 'بيانات صوت مو صالحة' }
    const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from((data as ArrayBufferView).buffer as ArrayBuffer)
    const f = path.join(os.tmpdir(), 'trl-stt-' + Date.now() + '.webm')
    try {
      await fsp.writeFile(f, bytes)
      const r = await transcribeLive(f)
      return r.error ? { ok: false, error: r.error } : { ok: true, text: r.text ?? '' }
    } finally {
      fsp.rm(f, { force: true }).catch(() => undefined)
    }
  })
  ipcMain.handle('voice:getVoice', async () => ({ voice: await arVoice() }))
  ipcMain.handle('voice:setVoice', async (_e, v: unknown) => {
    if (typeof v !== 'string' || !/^ar-[A-Z]{2}-[A-Za-z]+Neural$/.test(v)) return { ok: false }
    await fsp.writeFile(cfgPath(), JSON.stringify({ voice: v }))
    return { ok: true }
  })
  ipcMain.handle('voice:speak', async (_e, raw: unknown) => {
    if (typeof raw !== 'string') return { ok: false, error: 'نص مو صالح' }
    const text = cleanForSpeech(raw)
    if (!text) return { ok: false, error: 'ما في نص يتقرأ' }
    const base = path.join(os.tmpdir(), 'trl-tts-' + Date.now())
    let file = base + '.mp3'
    let mime = 'audio/mpeg'
    let note = ''
    try {
      const err = pickVoice(text) === VOICE_EN ? await edgeTts(text, VOICE_EN, file) : await edgeSegments(text, file)
      if (err) {
        note = 'الصوت الشامي ما اشتغل (' + err.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 90) + ') فاستعملت صوت ويندوز'
        file = base + '.wav'
        mime = 'audio/wav'
        const e2 = await windowsVoice(text, file)
        if (e2) return { ok: false, error: e2.slice(0, 200) }
      }
      const buf = await fsp.readFile(file)
      return { ok: true, url: `data:${mime};base64,${buf.toString('base64')}`, note }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      fsp.rm(base + '.mp3', { force: true }).catch(() => undefined)
      fsp.rm(base + '.wav', { force: true }).catch(() => undefined)
    }
  })
}
