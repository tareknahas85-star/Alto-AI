import { app, ipcMain } from 'electron'
import { execFile } from 'child_process'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { cleanForSpeech, pickVoice, splitSegments, VOICE_AR, VOICE_EN, SPEECH_RATE } from '../core/voice'

// Read-aloud: edge-tts (free, no key; needs internet) with the Syrian voice; falls back to the Windows voice when it can't run.
const run = (cmd: string, args: string[], ms: number): Promise<{ ok: boolean; err: string }> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true }, (e, _o, se) => resolve({ ok: !e, err: e ? (se || e.message).toString().slice(-300) : '' }))
  })

async function edgeTts(text: string, voice: string, out: string): Promise<string> {
  let last = ''
  for (const py of ['python', 'py']) {
    const args = (py === 'py' ? ['-3'] : []).concat(['-m', 'edge_tts', '--voice', voice, '--rate=' + SPEECH_RATE, '--text', text, '--write-media', out])
    let r = await run(py, args, 60000)
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
  const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $v=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -like '${/[؀-ۿ]/.test(text) ? 'ar*' : 'en*'}'}|Select-Object -First 1; if($v){$s.SelectVoice($v.VoiceInfo.Name)}; $s.SetOutputToWaveFile($env:TRL_OUT); $s.Speak($env:TRL_TEXT); $s.Dispose()`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 60000, windowsHide: true, env: { ...process.env, TRL_OUT: out, TRL_TEXT: text } }, (e) => resolve(e ? e.message : ''))
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
  const bufs: Buffer[] = []
  for (let i = 0; i < segs.length; i++) {
    const f = out + '.' + i
    const err = await edgeTts(segs[i].text, segs[i].lang === 'en' ? VOICE_EN : ar, f)
    if (err) { for (let j = 0; j <= i; j++) fsp.rm(out + '.' + j, { force: true }).catch(() => undefined); return err }
    bufs.push(await fsp.readFile(f))
    fsp.rm(f, { force: true }).catch(() => undefined)
  }
  await fsp.writeFile(out, Buffer.concat(bufs))
  return ''
}

export function registerVoiceIpc(): void {
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
