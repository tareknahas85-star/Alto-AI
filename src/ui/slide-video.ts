import type { Deck } from '../core/notebook'

// فيديو من الشرايح: بنرسم كل شريحة على canvas (1280x720) وبنشغّل تعليقها الصوتي (edge-tts) وبنسجّل الكل بـMediaRecorder لملف webm.
// ما بيحتاج ffmpeg ولا أي خدمة؛ التسجيل بيمشي بالوقت الحقيقي (مدة الفيديو = مدة الكلام).

const W = 1280
const H = 720
const FONT = '"Segoe UI", Tahoma, Arial, sans-serif'

function b64ToBytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u.buffer
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w
    if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w } else cur = t
  }
  if (cur) lines.push(cur)
  return lines
}

export function drawSlide(ctx: CanvasRenderingContext2D, deck: Deck, i: number): void {
  const s = deck.slides[i]
  ctx.direction = 'rtl'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  if (i === 0) {
    ctx.fillStyle = '#0f172a'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#38bdf8'
    ctx.fillRect(W - 120, 250, 80, 6)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 60px ' + FONT
    let y = 280
    for (const l of wrap(ctx, deck.title, W - 200).slice(0, 3)) { ctx.fillText(l, W - 120, y); y += 80 }
    if (s.title && s.title !== deck.title) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = '30px ' + FONT
      for (const l of wrap(ctx, s.title, W - 200).slice(0, 2)) { ctx.fillText(l, W - 120, y + 10); y += 44 }
    }
    return
  }
  ctx.fillStyle = '#f8fafc'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, W, 130)
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 44px ' + FONT
  const tl = wrap(ctx, s.title, W - 120).slice(0, 2)
  tl.forEach((l, k) => ctx.fillText(l, W - 60, tl.length > 1 ? 14 + k * 54 : 40))
  ctx.fillStyle = '#0f172a'
  ctx.font = '34px ' + FONT
  let y = 175
  for (const b of s.bullets.slice(0, 6)) {
    ctx.fillStyle = '#38bdf8'
    ctx.fillRect(W - 76, y + 14, 12, 12)
    ctx.fillStyle = '#0f172a'
    const bl = wrap(ctx, b, W - 200).slice(0, 2)
    bl.forEach((l, k) => ctx.fillText(l, W - 100, y + k * 44))
    y += bl.length * 44 + 22
    if (y > H - 60) break
  }
  ctx.fillStyle = '#94a3b8'
  ctx.font = '20px ' + FONT
  ctx.textAlign = 'left'
  ctx.direction = 'ltr'
  ctx.fillText(String(i + 1) + ' / ' + deck.slides.length, 30, H - 40)
}

export async function renderSlideVideo(deck: Deck, audioUrls: string[], onProgress: (done: number, total: number) => void): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('الـcanvas مو متوفر')
  const ac = new AudioContext()
  try {
    const buffers: AudioBuffer[] = []
    for (const u of audioUrls) buffers.push(await ac.decodeAudioData(b64ToBytes(u)))
    const dest = ac.createMediaStreamDestination()
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()])
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m))
    if (!mime) throw new Error('المتصفح الداخلي ما بيدعم تسجيل webm')
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 })
    const chunks: Blob[] = []
    rec.ondataavailable = (e): void => { if (e.data.size) chunks.push(e.data) }
    const stopped = new Promise<void>((res) => { rec.onstop = (): void => res() })
    let cur = 0
    drawSlide(ctx, deck, 0)
    const tick = setInterval(() => drawSlide(ctx, deck, cur), 200)
    rec.start(1000)
    for (let i = 0; i < deck.slides.length; i++) {
      cur = i
      drawSlide(ctx, deck, i)
      onProgress(i, deck.slides.length)
      const buf = buffers[i]
      if (buf) {
        const src = ac.createBufferSource()
        src.buffer = buf
        src.connect(dest)
        await new Promise<void>((res) => { src.onended = (): void => res(); src.start() })
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    clearInterval(tick)
    rec.stop()
    await stopped
    onProgress(deck.slides.length, deck.slides.length)
    return new Blob(chunks, { type: 'video/webm' })
  } finally {
    void ac.close()
  }
}
