// عميل صوت Gemini Live بالواجهة: بيلتقط المايك PCM16 16kHz وبيبعتو للـmain، وبيشغّل رد الموديل PCM 24kHz بدون انقطاع.
// لما الموديل يرجّع "interrupted" (المستخدم قاطعو) بنوقّف الصوت فوراً.

export interface LiveCallbacks {
  onState: (s: 'listen' | 'speak') => void
  onTurn: (user: string, model: string) => void
  onClose: (msg: string) => void
  onTool: (request: string) => Promise<string>
}

function b64ToInt16(b64: string): Int16Array {
  const bin = atob(b64)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Int16Array(u8.buffer, 0, Math.floor(u8.length / 2))
}

function int16ToB64(a: Int16Array): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

export async function startLiveAudio(cb: LiveCallbacks): Promise<{ ok: boolean; error?: string; model?: string; stop: () => void }> {
  const nop = (): void => undefined
  const r = await window.api.live.start()
  if (!r.ok) return { ok: false, error: r.error, stop: nop }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
  } catch (e) {
    void window.api.live.stop()
    return { ok: false, error: 'ما قدرت افتح المايك: ' + String((e as Error).message ?? e), stop: nop }
  }
  const ctxIn = new AudioContext({ sampleRate: 16000 })
  const ctxOut = new AudioContext({ sampleRate: 24000 })
  const src = ctxIn.createMediaStreamSource(stream)
  const proc = ctxIn.createScriptProcessor(2048, 1, 1)
  const mute = ctxIn.createGain()
  mute.gain.value = 0
  proc.onaudioprocess = (ev): void => {
    const f = ev.inputBuffer.getChannelData(0)
    const out = new Int16Array(f.length)
    for (let i = 0; i < f.length; i++) out[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff
    window.api.live.audio(int16ToB64(out))
  }
  src.connect(proc)
  proc.connect(mute)
  mute.connect(ctxIn.destination)

  const playing = new Set<AudioBufferSourceNode>()
  let nextAt = 0
  let userBuf = ''
  let modelBuf = ''
  let stopped = false

  const flush = (): void => {
    if (userBuf.trim() || modelBuf.trim()) cb.onTurn(userBuf.trim(), modelBuf.trim())
    userBuf = ''
    modelBuf = ''
  }
  const stopPlayback = (): void => {
    for (const s of playing) { try { s.stop() } catch { /* already ended */ } }
    playing.clear()
    nextAt = 0
  }
  const play = (b64: string): void => {
    const i16 = b64ToInt16(b64)
    const buf = ctxOut.createBuffer(1, i16.length, 24000)
    const ch = buf.getChannelData(0)
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 0x8000
    const s = ctxOut.createBufferSource()
    s.buffer = buf
    s.connect(ctxOut.destination)
    const t = Math.max(ctxOut.currentTime + 0.03, nextAt)
    s.start(t)
    nextAt = t + buf.duration
    playing.add(s)
    cb.onState('speak')
    s.onended = (): void => {
      playing.delete(s)
      if (!playing.size && !stopped) cb.onState('listen')
    }
  }

  const off = window.api.live.onEvent((ev) => {
    if (stopped) return
    switch (ev.type) {
      case 'audio': play(ev.data as string); break
      case 'interrupted': stopPlayback(); flush(); cb.onState('listen'); break
      case 'userText': userBuf += ev.text as string; break
      case 'modelText': modelBuf += ev.text as string; break
      case 'turnComplete': flush(); break
      case 'toolCall': {
        const id = String(ev.id)
        const name = String(ev.name)
        void cb.onTool(String(ev.request)).then(
          (res) => { if (!stopped) window.api.live.toolResponse(id, name, res) },
          (err) => { if (!stopped) window.api.live.toolResponse(id, name, 'فشل التنفيذ: ' + String((err as Error).message ?? err)) },
        )
        break
      }
      case 'goAway': cb.onClose('Gemini Live عم يسكّر الجلسة (حد الوقت). دوس زر المحادثة لتفتحها من جديد.'); break
      case 'error': cb.onClose('خطأ بـGemini Live: ' + String(ev.error)); break
      case 'closed': cb.onClose('انسكرت جلسة Gemini Live (' + String(ev.code) + ' ' + String(ev.reason ?? '') + ')'); break
    }
  })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    off()
    stopPlayback()
    try { proc.disconnect(); src.disconnect() } catch { /* ignore */ }
    stream.getTracks().forEach((t) => t.stop())
    void ctxIn.close()
    void ctxOut.close()
    void window.api.live.stop()
    flush()
  }
  cb.onState('listen')
  return { ok: true, model: r.model, stop }
}
