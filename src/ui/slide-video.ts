import type { Deck } from '../core/notebook'
import { H, W, drawSlide } from './slide-draw'

export { drawSlide }

// فيديو من الشرايح: بنرسم كل شريحة على canvas (1280x720) وبنشغّل تعليقها الصوتي (صوت سعاد) وبنسجّل الكل بـMediaRecorder لملف webm.
// ما بيحتاج ffmpeg ولا أي خدمة؛ التسجيل بيمشي بالوقت الحقيقي (مدة الفيديو = مدة الكلام).


function b64ToBytes(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u.buffer
}

/** وقت بداية صوت كل شريحة على ساعة الصوت: ورا بعض مع فاصل gap. */
export function schedule(durations: number[], t0: number, gap: number): number[] {
  const out: number[] = []
  let t = t0
  for (const d of durations) { out.push(t); t += d + gap }
  return out
}

/** أي شريحة لازم تكون عالشاشة بلحظة now (آخر شريحة بلّش وقتها). */
export function slideAt(starts: number[], now: number): number {
  let i = 0
  while (i + 1 < starts.length && now >= starts[i + 1]) i++
  return i
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
    // التزامن: كل الصوت بينجدول على ساعة الـAudioContext (ما بتتأخر حتى لو النافذة مخفية)، والشريحة بتتبدّل
    // حسب نفس الساعة، وبتطلع قبل صوتها بشوي (LEAD) مشان ما يسبق الصوت الصورة.
    const LEAD = 0.4
    const GAP = 0.7
    const durs = deck.slides.map((_, i) => buffers[i]?.duration ?? 2)
    const starts = schedule(durs, ac.currentTime + 0.6, GAP)
    const end = starts[starts.length - 1] + durs[durs.length - 1] + GAP
    buffers.forEach((buf, i) => {
      if (!buf) return
      const src = ac.createBufferSource()
      src.buffer = buf
      src.connect(dest)
      src.start(starts[i])
    })
    let cur = 0
    drawSlide(ctx, deck, 0)
    rec.start(1000)
    onProgress(0, deck.slides.length)
    await new Promise<void>((res) => {
      const tick = setInterval(() => {
        const i = slideAt(starts, ac.currentTime + LEAD)
        if (i !== cur) { cur = i; onProgress(i, deck.slides.length) }
        drawSlide(ctx, deck, cur)
        if (ac.currentTime >= end) { clearInterval(tick); res() }
      }, 40)
    })
    rec.stop()
    await stopped
    onProgress(deck.slides.length, deck.slides.length)
    return new Blob(chunks, { type: 'video/webm' })
  } finally {
    void ac.close()
  }
}
