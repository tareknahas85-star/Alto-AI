// تحضير نص للقراية بصوت عالي: بلا روابط ولا رموز Markdown، ومقسوم لقطع قصيرة (كل قطعة بتنحكى بطلب صوت واحد).

/** بيشيل الروابط والرموز والجداول، وبيترك الكلام بس. */
export function cleanForSpeech(t: string): string {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/[*_`#>|~]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** بيقسم النص عحدود الجمل لقطع ما بتتعدى max حرف (جملة أطول من max بتنقص). */
export function speechChunks(t: string, max = 450): string[] {
  const out: string[] = []
  let cur = ''
  for (const p of t.split(/(?<=[.!?؟۔،\n])\s+/)) {
    if (!p) continue
    if (cur && (cur + ' ' + p).length > max) {
      out.push(cur)
      cur = p
    } else cur = cur ? cur + ' ' + p : p
  }
  if (cur) out.push(cur)
  return out.flatMap((x) => (x.length > max ? x.match(new RegExp('[\\s\\S]{1,' + max + '}', 'g')) ?? [] : [x]))
}
