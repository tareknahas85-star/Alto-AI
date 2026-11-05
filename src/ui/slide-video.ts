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
