import type { Deck, Slide, SlideLayout } from '../core/notebook'

// رسم الشرايح بصرياً على canvas (1280x720): غلاف، مربعات، خريطة ذهنية، خطوات، قائمة. كل شي بإيموجي وألوان مختلفة لتشدّ النظر.
export const W = 1280
export const H = 720
const FONT = '"Segoe UI", Tahoma, Arial, sans-serif'
const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji"'
const ACCENTS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#f97316']
const FALLBACK_ICONS = ['✨', '🚀', '💡', '🎯', '🧩', '🔧']

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

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function emoji(ctx: CanvasRenderingContext2D, ch: string, x: number, y: number, size: number): void {
  ctx.save()
  ctx.font = size + 'px ' + EMOJI
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(ch, x, y)
  ctx.restore()
}

function centerText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, size: number, color: string, maxLines = 3, bold = true): void {
  ctx.save()
  ctx.font = (bold ? 'bold ' : '') + size + 'px ' + FONT
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lines = wrap(ctx, text, maxW).slice(0, maxLines)
  const lh = size * 1.3
  lines.forEach((l, k) => ctx.fillText(l, cx, cy + (k - (lines.length - 1) / 2) * lh))
  ctx.restore()
}

function iconOf(s: Slide, i: number): string {
  return s.icons?.[i] || FALLBACK_ICONS[i % FALLBACK_ICONS.length]
}

function background(ctx: CanvasRenderingContext2D, dark: boolean, accent: string): void {
  ctx.fillStyle = dark ? '#0b1220' : '#f1f5f9'
  ctx.fillRect(0, 0, W, H)
  ctx.save()
  ctx.globalAlpha = dark ? 0.18 : 0.12
  ctx.fillStyle = accent
  ctx.beginPath(); ctx.arc(W - 90, 80, 260, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(120, H - 40, 220, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}

function header(ctx: CanvasRenderingContext2D, s: Slide, accent: string): void {
  ctx.fillStyle = '#0b1220'
  ctx.fillRect(0, 0, W, 120)
  ctx.fillStyle = accent
  ctx.fillRect(0, 116, W, 4)
  if (s.icon) emoji(ctx, s.icon, W - 70, 60, 60)
  centerText(ctx, s.title, W / 2 - (s.icon ? 20 : 0), 60, W - 300, 46, '#ffffff', 2)
}

function drawCover(ctx: CanvasRenderingContext2D, deck: Deck, s: Slide): void {
  background(ctx, true, '#38bdf8')
  emoji(ctx, s.icon || '🤖', W / 2, 170, 130)
  centerText(ctx, deck.title, W / 2, 360, W - 200, 62, '#ffffff', 3)
  if (s.title && s.title !== deck.title) centerText(ctx, s.title, W / 2, 520, W - 260, 32, '#7dd3fc', 2, false)
  const chips = s.bullets.slice(0, 4)
  chips.forEach((b, k) => {
    const cw = 250
    const x = W / 2 + (chips.length - 1) * (cw + 20) / 2 - k * (cw + 20)
    ctx.fillStyle = ACCENTS[k % ACCENTS.length]
    rr(ctx, x - cw / 2, 590, cw, 56, 28); ctx.fill()
    centerText(ctx, (s.icons?.[k] ? s.icons[k] + ' ' : '') + b, x, 618, cw - 20, 22, '#0b1220', 1)
  })
}

function drawCards(ctx: CanvasRenderingContext2D, s: Slide): void {
  background(ctx, false, '#38bdf8')
  header(ctx, s, '#38bdf8')
  const items = s.bullets.slice(0, 6)
  const n = Math.max(items.length, 1)
  const cols = n <= 2 ? n : n === 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const gap = 28
  const areaX = 60
  const areaY = 160
  const areaW = W - 120
  const areaH = H - areaY - 50
  const cw = (areaW - gap * (cols - 1)) / cols
  const ch = Math.min(280, (areaH - gap * (rows - 1)) / rows)
  items.forEach((b, k) => {
    const row = Math.floor(k / cols)
    const col = k % cols
    const itemsInRow = Math.min(cols, n - row * cols)
    const rowW = itemsInRow * cw + (itemsInRow - 1) * gap
    const x = areaX + (areaW - rowW) / 2 + rowW - cw - col * (cw + gap)
    const y = areaY + row * (ch + gap) + (areaH - (rows * ch + (rows - 1) * gap)) / 2
    const ac = ACCENTS[k % ACCENTS.length]
    ctx.save()
    ctx.shadowColor = 'rgba(15,23,42,0.18)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6
    ctx.fillStyle = '#ffffff'
    rr(ctx, x, y, cw, ch, 26); ctx.fill()
    ctx.restore()
    ctx.fillStyle = ac
    rr(ctx, x, y, cw, 12, 6); ctx.fill()
    emoji(ctx, iconOf(s, k), x + cw / 2, y + ch * 0.36, Math.min(84, ch * 0.34))
    centerText(ctx, b, x + cw / 2, y + ch * 0.74, cw - 40, 28, '#0f172a', 3)
  })
}

function drawMindmap(ctx: CanvasRenderingContext2D, s: Slide): void {
  background(ctx, true, '#a78bfa')
  const items = s.bullets.slice(0, 6)
  const cx = W / 2
  const cy = H / 2 + 6
  const rx = 440
  const ry = 235
  items.forEach((_, k) => {
    const a = -Math.PI / 2 + (k / items.length) * Math.PI * 2 + Math.PI / items.length
    const x = cx + Math.cos(a) * rx
    const y = cy + Math.sin(a) * ry
    ctx.strokeStyle = ACCENTS[k % ACCENTS.length]
    ctx.lineWidth = 6
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.quadraticCurveTo((cx + x) / 2, cy, x, y); ctx.stroke()
  })
  ctx.fillStyle = '#7c3aed'
  ctx.beginPath(); ctx.ellipse(cx, cy, 190, 100, 0, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 5; ctx.stroke()
  if (s.icon) emoji(ctx, s.icon, cx, cy - 52, 44)
  centerText(ctx, s.title, cx, cy + (s.icon ? 18 : 0), 320, 32, '#ffffff', 2)
  items.forEach((b, k) => {
    const a = -Math.PI / 2 + (k / items.length) * Math.PI * 2 + Math.PI / items.length
    const x = cx + Math.cos(a) * rx
    const y = cy + Math.sin(a) * ry
    const bw = 270
    const bh = 96
    ctx.fillStyle = '#111c33'
    rr(ctx, x - bw / 2, y - bh / 2, bw, bh, 22); ctx.fill()
    ctx.strokeStyle = ACCENTS[k % ACCENTS.length]; ctx.lineWidth = 4; ctx.stroke()
    emoji(ctx, iconOf(s, k), x + bw / 2 - 34, y, 36)
    centerText(ctx, b, x - 24, y, bw - 100, 24, '#f8fafc', 2)
  })
}

function drawSteps(ctx: CanvasRenderingContext2D, s: Slide): void {
  background(ctx, false, '#34d399')
  header(ctx, s, '#34d399')
  const items = s.bullets.slice(0, 5)
  const n = Math.max(items.length, 1)
  const gap = 24
  const cw = (W - 120 - gap * (n - 1)) / n
  items.forEach((b, k) => {
    const x = W - 60 - cw - k * (cw + gap)
    const y = 190
    const ac = ACCENTS[k % ACCENTS.length]
    ctx.save()
    ctx.shadowColor = 'rgba(15,23,42,0.18)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6
    ctx.fillStyle = '#ffffff'
    rr(ctx, x, y + 40, cw, 400, 24); ctx.fill()
    ctx.restore()
    ctx.fillStyle = ac
    ctx.beginPath(); ctx.arc(x + cw / 2, y + 40, 40, 0, Math.PI * 2); ctx.fill()
    centerText(ctx, String(k + 1), x + cw / 2, y + 40, 60, 40, '#0b1220', 1)
    emoji(ctx, iconOf(s, k), x + cw / 2, y + 160, Math.min(80, cw * 0.4))
    centerText(ctx, b, x + cw / 2, y + 310, cw - 30, 26, '#0f172a', 4)
    if (k < n - 1) { ctx.fillStyle = ac; ctx.font = 'bold 44px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('◀', x - gap / 2, y + 240) }
  })
}

function drawList(ctx: CanvasRenderingContext2D, s: Slide): void {
  background(ctx, false, '#fbbf24')
  header(ctx, s, '#fbbf24')
  const items = s.bullets.slice(0, 6)
  let y = 165
  items.forEach((b, k) => {
    ctx.fillStyle = '#ffffff'
    rr(ctx, 80, y, W - 160, 72, 18); ctx.fill()
    ctx.fillStyle = ACCENTS[k % ACCENTS.length]
    rr(ctx, W - 86, y, 10, 72, 5); ctx.fill()
    emoji(ctx, iconOf(s, k), W - 130, y + 36, 40)
    ctx.textAlign = 'right'
    centerText(ctx, b, W / 2 - 40, y + 36, W - 380, 30, '#0f172a', 1)
    y += 88
  })
}

export function layoutOf(deck: Deck, i: number): SlideLayout {
  const s = deck.slides[i]
  if (i === 0) return 'cover'
  if (s.layout && s.layout !== 'cover') return s.layout
  return s.bullets.length >= 2 && s.bullets.every((b) => b.split(/\s+/).length <= 6) ? 'cards' : 'list'
}

export function drawSlide(ctx: CanvasRenderingContext2D, deck: Deck, i: number): void {
  const s = deck.slides[i]
  ctx.save()
  ctx.direction = 'rtl'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lay = layoutOf(deck, i)
  if (lay === 'cover') drawCover(ctx, deck, s)
  else if (lay === 'mindmap') drawMindmap(ctx, s)
  else if (lay === 'steps') drawSteps(ctx, s)
  else if (lay === 'list') drawList(ctx, s)
  else drawCards(ctx, s)
  // نقاط التقدّم تحت
  const n = deck.slides.length
  for (let k = 0; k < n; k++) {
    ctx.fillStyle = k === i ? '#38bdf8' : 'rgba(148,163,184,0.5)'
    ctx.beginPath(); ctx.arc(W / 2 + (k - (n - 1) / 2) * 22, H - 22, k === i ? 6 : 4, 0, Math.PI * 2); ctx.fill()
  }
  ctx.restore()
}
