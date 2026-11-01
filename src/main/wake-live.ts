import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'

// كلمة التنبيه (wake word) محلية بالكامل بمكتبة openWakeWord المجانية. الواجهة بتبعت صوت المايك PCM16 16kHz
// (دفعات 1280 عينة)، والـpython بيحكي "WAKE" لما يسمع «Hey Jarvis». ما في شي بيطلع من الجهاز.

const PY = [
  'import sys, os, time, subprocess, urllib.request',
  'try:',
  '    import openwakeword',
  'except Exception:',
  '    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "openwakeword", "--no-deps"], check=False)',
  '    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "tqdm", "requests", "scikit-learn", "numpy", "onnxruntime"], check=False)',
  '    import openwakeword',
  'import numpy as np',
  'from openwakeword.utils import download_models',
  'from openwakeword.model import Model',
  'def make():',
  '    return Model(wakeword_models=["hey_jarvis"], inference_framework="onnx")',
  'try:',
  '    m = make()',
  'except Exception:',
  '    try:',
  '        download_models(["hey_jarvis"])',
  '    except Exception:',
  '        pass',
  '    d = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models", "melspectrogram.onnx")',
  '    if not os.path.exists(d):',
  '        urllib.request.urlretrieve("https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx", d)',
  '    m = make()',
  'print("READY", flush=True)',
  'last = 0.0',
  'rd = sys.stdin.buffer',
  'while True:',
  '    b = rd.read(2560)',
  '    if not b or len(b) < 2560:',
  '        break',
  '    p = m.predict(np.frombuffer(b, dtype=np.int16))',
  '    if p.get("hey_jarvis", 0) > 0.5 and time.time() - last > 3:',
  '        last = time.time()',
  '        print("WAKE", flush=True)',
].join('\n')

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
      const py = process.platform === 'win32' ? 'python' : 'python3'
      const p = spawn(py, ['-c', PY], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      proc = p
      let done = false
      let buf = ''
      let err = ''
      const fin = (r: { ok: boolean; error?: string }): void => { if (!done) { done = true; clearTimeout(t); resolve(r) } }
      const t = setTimeout(() => { stopWake(); fin({ ok: false, error: 'انتهت المهلة وانا عم جهّز كلمة التنبيه (بايثون / openWakeWord)' }) }, 240000)
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf-8')
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line === 'READY') fin({ ok: true })
          else if (line === 'WAKE') emit({ type: 'wake' })
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
