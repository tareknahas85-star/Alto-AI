import { app, ipcMain, type WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { pythons } from './whisper-live'

// كلمة التنبيه (wake word) محلية بالكامل بمكتبة Whisper الصغير (base). الواجهة بتبعت صوت المايك PCM16 16kHz
// (دفعات 1280 عينة)، والـpython بيحكي "WAKE" لما يسمع «سعاد». ما في شي بيطلع من الجهاز.

const PY = [
  'import sys, os, re, time',
  'import numpy as np',
  'from faster_whisper import WhisperModel',
  'm = WhisperModel(os.environ.get("VOICE_WAKE_MODEL", "base"), device="cpu", compute_type="int8", cpu_threads=2)',
  'PAT = re.compile("^(\\u064a\\u0627)?\\u0633[\\u0648\\u0639]{1,2}[\\u0627\\u0623\\u0622]?[\\u062f\\u062a\\u0637\\u0636]$|^(suad|souad|soad|su3ad|so3ad|swad|sawad|saad)$", re.I)',
  'SPL = re.compile("[\\\\s,.!?\\u061f\\u060c:;]+")',
  'print("READY", flush=True)',
  'rd = sys.stdin.buffer',
  'floor = 150.0',
  'seg = []',
  'sil = 0',
  'last = 0.0',
  'cnt = 0',
  'mx = 0.0',
  'while True:',
  '    b = rd.read(2560)',
  '    if not b or len(b) < 2560:',
  '        break',
  '    a = np.frombuffer(b, dtype=np.int16)',
  '    r = float(np.sqrt(np.mean(a.astype(np.float32) ** 2)))',
  '    thr = max(220.0, floor * 2.5)',
  '    cnt += 1',
  '    mx = max(mx, r)',
  '    if cnt % 25 == 0:',
  '        print("LEVEL:%d:%d" % (int(mx), int(thr)), flush=True)',
  '        mx = 0.0',
  '    if r > thr:',
  '        seg.append(a)',
  '        sil = 0',
  '    elif seg:',
  '        seg.append(a)',
  '        sil += 1',
  '    else:',
  '        floor = 0.95 * floor + 0.05 * min(r, 600.0)',
  '    if seg and (sil >= 6 or len(seg) >= 40):',
  '        n = len(seg) - sil',
  '        if n >= 4 and time.time() - last > 3:',
  '            x = np.concatenate(seg).astype(np.float32) / 32768.0',
  '            try:',
  '                ss, _ = m.transcribe(x, language="ar", beam_size=1, vad_filter=False, condition_on_previous_text=False)',
  '                txt = " ".join(s.text for s in ss).strip()',
  '                if txt:',
  '                    print("HEARD:" + txt, flush=True)',
  '                if txt and len(txt.split()) <= 8 and any(PAT.match(w) for w in SPL.split(txt)):',
  '                    last = time.time()',
  '                    print("WAKE", flush=True)',
  '            except Exception:',
  '                pass',
  '        seg = []',
  '        sil = 0',
].join('\n')

function dbg(m: string): void {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'wake-debug.log'), new Date().toISOString() + ' ' + m + '\n') } catch { /* ignore */ }
}

let proc: ChildProcessWithoutNullStreams | null = null
let sender: WebContents | null = null

function emit(ev: Record<string, unknown>): void {
  try { sender?.send('wake:event', ev) } catch { /* window closed */ }
}

function stopWake(): void {
  const p = proc
  proc = null
  try { p?.kill() } catch { /* ignore */ }
}

export function registerWakeIpc(): void {
  ipcMain.handle('wake:start', (e) => {
    stopWake()
    sender = e.sender
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const py = pythons()[0] ?? (process.platform === 'win32' ? 'python' : 'python3')
      const p = spawn(py, ['-c', PY], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      proc = p
      let done = false
      let buf = ''
      let err = ''
      const fin = (r: { ok: boolean; error?: string }): void => { if (!done) { done = true; clearTimeout(t); resolve(r) } }
      const t = setTimeout(() => { stopWake(); fin({ ok: false, error: 'انتهت المهلة وانا عم جهّز كلمة التنبيه (Whisper base، أول مرة بينزّل شي 140MB)' }) }, 240000)
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf-8')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line === 'READY') fin({ ok: true })
          else if (line === 'WAKE') emit({ type: 'wake' })
          else if (line.startsWith('HEARD:')) { emit({ type: 'heard', text: line.slice(6) }); dbg('HEARD ' + line.slice(6)) }
          else if (line.startsWith('LEVEL:')) emit({ type: 'level', text: line.slice(6) })
        }
      })
      p.stderr.on('data', (d: Buffer) => { err = (err + d.toString('utf-8')).slice(-400) })
      p.stdin.on('error', () => undefined)
      p.on('error', (x) => { fin({ ok: false, error: 'بايثون مو موجود: ' + x.message }); if (proc === p) proc = null })
      p.on('close', () => {
        fin({ ok: false, error: 'تعذّر تشغيل كلمة التنبيه. ' + err.trim().split('\n').pop() })
        if (proc === p) { proc = null; emit({ type: 'closed' }) }
      })
    })
  })

  ipcMain.on('wake:audio', (_e, data: unknown) => {
    if (!proc || !proc.stdin.writable) return
    if (data instanceof Uint8Array) proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  })

  ipcMain.handle('wake:stop', () => { stopWake(); return true })
}
