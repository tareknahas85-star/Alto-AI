import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Voice conversation needs fast speech-to-text: one long-lived faster-whisper process keeps the model in memory
// (the normal file transcription reloads the model on every call, which is what made voice mode slow).
const PY = `
import sys, os, json
from faster_whisper import WhisperModel
m = WhisperModel(os.environ.get("VOICE_WHISPER_MODEL", "small"), device="cpu", compute_type="int8", cpu_threads=max(4, (os.cpu_count() or 8) // 2))
sys.stdout.write("READY\\n"); sys.stdout.flush()
for line in sys.stdin:
    f = line.strip()
    if not f:
        continue
    try:
        segs, info = m.transcribe(f, language=os.environ.get("VOICE_WHISPER_LANG", "ar") or None, beam_size=1, vad_filter=True, condition_on_previous_text=False)
        out = {"text": " ".join(s.text.strip() for s in segs).strip(), "lang": info.language}
    except Exception as e:
        out = {"error": str(e)[:200]}
    sys.stdout.write(json.dumps(out, ensure_ascii=True) + "\\n"); sys.stdout.flush()
`

export function pythons(): string[] {
  const home = os.homedir()
  return [
    process.env.WHISPER_PYTHON ?? '',
    path.join(home, 'mcp-venvs', 'whisper', 'Scripts', 'python.exe'),
    path.join(home, 'mcp-venvs', 'whisper', 'bin', 'python'),
    process.platform === 'win32' ? 'python' : 'python3'
  ].filter((p) => p && (!path.isAbsolute(p) || fs.existsSync(p)))
}

let proc: ChildProcessWithoutNullStreams | null = null
let ready: Promise<boolean> | null = null
let buf = ''
let waiter: ((line: string) => void) | null = null
let idle: NodeJS.Timeout | null = null
let chain: Promise<unknown> = Promise.resolve()

function stop(): void {
  try { proc?.kill() } catch { /* ignore */ }
  proc = null
  ready = null
  buf = ''
  waiter = null
}

function start(): Promise<boolean> {
  if (ready) return ready
  const py = pythons()[0]
  if (!py) return Promise.resolve(false)
  ready = new Promise<boolean>((resolve) => {
    const p = spawn(py, ['-c', PY], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    proc = p
    let ok = false
    waiter = (line) => { if (line === 'READY') { ok = true; waiter = null; resolve(true) } }
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf-8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line && waiter) waiter(line)
      }
    })
    p.stderr.on('data', () => undefined)
    p.on('error', () => { if (!ok) resolve(false); stop() })
    p.on('close', () => { if (!ok) resolve(false); stop() })
  })
  return ready
}

export function warmWhisper(): void {
  void start()
}

export function transcribeLive(file: string): Promise<{ text?: string; error?: string }> {
  const job = async (): Promise<{ text?: string; error?: string }> => {
    if (idle) clearTimeout(idle)
    if (!(await start()) || !proc) return { error: 'Whisper المحلي مو شغّال (faster-whisper)' }
    const line = await new Promise<string>((resolve) => {
      const t = setTimeout(() => { waiter = null; stop(); resolve('') }, 90000)
      waiter = (l) => { clearTimeout(t); waiter = null; resolve(l) }
      proc?.stdin.write(file + '\n')
    })
    idle = setTimeout(stop, 10 * 60 * 1000)
    if (!line) return { error: 'انتهت مهلة التفريغ' }
    try {
      const j = JSON.parse(line) as { text?: string; error?: string }
      return j.error ? { error: j.error } : { text: (j.text ?? '').trim() }
    } catch {
      return { error: 'ردّ غير مفهوم من Whisper' }
    }
  }
  const r = chain.then(job, job)
  chain = r.catch(() => undefined)
  return r
}

export function stopWhisperLive(): void {
  stop()
}
