// «شو الجديد» بيقرا أول قسم من CHANGELOG.md وقت البناء، فما عاد في نص ثابت بينسى يتحدّث.

export type ReleaseNotes = { version: string; notes: string[] }

/** بيرجّع رقم أول نسخة بالـCHANGELOG ونقاطها (بلا رموز Markdown). */
export function latestNotes(md: string): ReleaseNotes | null {
  const lines = String(md || '').split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+\d+\.\d+\.\d+/.test(l))
  if (start < 0) return null
  const version = (lines[start].match(/\d+\.\d+\.\d+/) ?? [''])[0]
  const notes: string[] = []
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*[-*]\s+(.*)$/)
    if (m) notes.push(m[1].replace(/\*\*|__|`/g, '').trim())
    else if (lines[i].trim() && notes.length) notes[notes.length - 1] += ' ' + lines[i].trim().replace(/\*\*|__|`/g, '')
  }
  return { version, notes: notes.filter(Boolean) }
}
