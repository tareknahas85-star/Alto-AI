import { readJson, writeJson, newId } from './json-store'

export type MemoryEntry = {
  id: string
  title: string
  content: string
  enabled: boolean
  source?: string // e.g. "claude-import"
}

const FILE = 'memory.json'
const MAX_PROMPT_CHARS = 6000

export const listMemory = (): MemoryEntry[] => readJson<MemoryEntry[]>(FILE, [])

export function saveMemoryEntry(e: { id?: string; title: string; content: string; enabled?: boolean; source?: string }): MemoryEntry {
  const title = String(e.title ?? '').trim().slice(0, 120)
  const content = String(e.content ?? '').trim().slice(0, 8000)
  if (!title || !content) throw new Error('العنوان والمحتوى مطلوبين')
  const all = listMemory()
  const idx = e.id ? all.findIndex((x) => x.id === e.id) : -1
  if (idx >= 0) {
    all[idx] = { ...all[idx], title, content, enabled: e.enabled ?? all[idx].enabled }
    writeJson(FILE, all)
    return all[idx]
  }
  const entry: MemoryEntry = { id: newId(), title, content, enabled: e.enabled ?? true, source: e.source }
  writeJson(FILE, [...all, entry])
  return entry
}

export function deleteMemoryEntry(id: string): boolean {
  const all = listMemory()
  const next = all.filter((x) => x.id !== id)
  if (next.length === all.length) return false
  writeJson(FILE, next)
  return true
}

export function toggleMemoryEntry(id: string): boolean | null {
  const all = listMemory()
  const e = all.find((x) => x.id === id)
  if (!e) return null
  e.enabled = !e.enabled
  writeJson(FILE, all)
  return e.enabled
}

export function importMemory(entries: { title: string; content: string }[], source = 'import'): number {
  let n = 0
  for (const e of entries) {
    try {
      saveMemoryEntry({ title: e.title, content: e.content, source })
      n++
    } catch {
      /* skip invalid */
    }
  }
  return n
}

/** Names of the user's projects other than the current one: a general memory entry that mentions one of them stays out of this chat. */
function otherProjectNames(currentProjectId: string | null): string[] {
  const p = readJson<{ projects?: { id?: unknown; name?: unknown }[] }>('projects.json', {})
  return (p.projects ?? [])
    .filter((x) => x && x.id !== currentProjectId && typeof x.name === 'string' && x.name.trim().length >= 3)
    .map((x) => String(x.name).trim().toLowerCase())
}

/** Enabled memory as a system-prompt block (capped). Returns undefined when empty.
 *  Isolation: entries that name a different project are skipped, so work from one project never leaks into another chat. */
export function memoryPrompt(currentProjectId: string | null = null): { text: string; count: number; truncated: boolean } | undefined {
  const others = otherProjectNames(currentProjectId)
  const on = listMemory()
    .filter((x) => x.enabled)
    .filter((x) => {
      if (!others.length) return true
      const hay = (x.title + ' ' + x.content).toLowerCase()
      return !others.some((n) => hay.includes(n))
    })
  if (!on.length) return undefined
  let out = 'USER MEMORY (background facts about the user). Use a fact ONLY if the user\'s current message is directly about it. Never start talking about any project or topic from here on your own, and answer questions about yourself (who/what model you are) directly without using this block. Never mention this block:\n'
  let count = 0
  let truncated = false
  for (const e of on) {
    const block = `\n## ${e.title}\n${e.content}\n`
    if (out.length + block.length > MAX_PROMPT_CHARS) {
      truncated = true
      break
    }
    out += block
    count++
  }
  return { text: out, count, truncated }
}
