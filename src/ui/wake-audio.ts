// بيلتقط المايك PCM16 16kHz بدفعات 1280 عينة وبيبعتها للـmain (openWakeWord). لما يسمع كلمة التنبيه بينادي onWake.
export async function startWake(onWake: () => void): Promise<{ ok: boolean; error?: string; stop: () => void }> {
  const nop = (): void => undefined
  const r = await window.api.wake.start()
  if (!r.ok) return { ok: false, error: r.error, stop: nop }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  } catch (e) {
    void window.api.wake.stop()
    return { ok: false, error: 'ما قدرت افتح المايك: ' + String((e as Error).message ?? e), stop: nop }
  }
  const ctx = new AudioContext({ sampleRate: 16000 })
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(2048, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0
  let pending = new Int16Array(0)
  proc.onaudioprocess = (ev): void => {
    const f = ev.inputBuffer.getChannelData(0)
    const merged = new Int16Array(pending.length + f.length)
    merged.set(pending)
    for (let i = 0; i < f.length; i++) merged[pending.length + i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff
    let o = 0
    while (merged.length - o >= 1280) {
      window.api.wake.audio(new Uint8Array(merged.slice(o, o + 1280).buffer))
      o += 1280
    }
    pending = merged.slice(o)
  }
  src.connect(proc)
  proc.connect(mute)
  mute.connect(ctx.destination)
  const off = window.api.wake.onEvent((ev) => { if (ev.type === 'wake') onWake() })
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    off()
    try { proc.disconnect(); src.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    void window.api.wake.stop()
  }
  return { ok: true, stop }
}
