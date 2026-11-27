import { getPrefs } from './prefs'
import { writeJson } from './json-store'
import { listMemory, saveMemoryEntry, deleteMemoryEntry } from './memory'
import { looksSecret, projectNames, getBlocked } from './agent-memory'
import { modelBlockReason, noteModelFailure, noteModelOk } from './model-health'

// Automatic memory: after an answered turn, pull out the DURABLE facts the user stated about themselves
// (preferences, setup, standing rules) and add them to the normal memory list with the source "تلقائي".
// Everything is visible and deletable in the memory panel, and the whole feature can be switched off.
// Never runs for confidential projects, scheduled runs or "private mode", never uses a local or subscription model,
// never stores anything that looks like a secret or names one of the user's projects.
export const AUTO_SOURCE = 'تلقائي'
const MAX_AUTO = 60
const MIN_GAP_MS = 20000
const MAX_FACTS = 3

export type Fact = { title: string; content: string }

// Cheap gate so a model is only called when the message plausibly states something lasting about the user.
const CUE_RE =
  /(أنا |انا |عندي|عندنا|بحب|بفضّل|بفضل|ما بحب|دايماً|دائماً|دايما|ديما|كل مرة|اسمي|بشتغل|شغلي|جهازي|عم استخدم|بستخدم|لا تعمل|ما تعمل|لا تستخدم|ما تستخدم|خلّيك|خليك|تذكّر|تذكر|\bmy\b|\bi (am|use|prefer|like|work|always|never|have)\b|\balways\b|\bnever\b|\bremember\b|\bfrom now on\b)/i

export function worthExtracting(userMsg: string): boolean {
  const t = String(userMsg ?? '').trim()
  return t.length >= 15 && t.length <= 2500 && CUE_RE.test(t)
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim()

/** Parses the model's JSON answer into safe facts: capped, deduped, no secrets, no blocked words. */
export function parseFacts(text: string, blocked: string[] = []): Fact[] {
  const m = String(text ?? '').match(/\{[\s\S]*\}/)
  if (!m) return []
  let raw: unknown
  try {
    raw = (JSON.parse(m[0]) as { facts?: unknown }).facts
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: Fact[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    const o = x as { title?: unknown; content?: unknown }
    const title = typeof o?.title === 'string' ? o.title.trim().slice(0, 60) : ''
    const content = typeof o?.content === 'string' ? o.content.trim().slice(0, 220) : ''
    if (title.length < 2 || content.length < 6) continue
    const hay = (title + ' ' + content).toLowerCase()
    if (looksSecret(title) || looksSecret(content)) continue
    if (blocked.some((b) => b && hay.includes(b.toLowerCase()))) continue
    const k = norm(content)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ title, content })
    if (out.length >= MAX_FACTS) break
  }
  return out
}

/** Adds new facts to memory (skipping ones already known); keeps at most MAX_AUTO automatic entries. Returns how many were added. */
export function mergeFacts(facts: Fact[]): number {
  const have = listMemory()
  const known = have.map((e) => norm(e.content))
  let added = 0
  for (const f of facts) {
    const k = norm(f.content)
    if (known.some((x) => x === k || x.includes(k) || k.includes(x))) continue
    saveMemoryEntry({ title: f.title, content: f.content, source: AUTO_SOURCE })
    known.push(k)
    added++
  }
  if (added) {
    const autos = listMemory().filter((e) => e.source === AUTO_SOURCE)
    for (const old of autos.slice(0, Math.max(0, autos.length - MAX_AUTO))) deleteMemoryEntry(old.id)
  }
  return added
}

/** A cheap cloud model for the extraction: the fastest scan-qualified API model, else the chosen master if it is an API model. Never local, never the CLI. */
async function extractorClient(): Promise<{ client: import('openai').default; modelId: string } | null> {
  // Loaded lazily: these modules pull in the whole master stack, which the pure helpers above (and their tests) do not need.
  const { loadScan } = await import('./master-scan')
  const { masterClientFor } = await import('./master')
  const ids = Object.values(loadScan().entries)
    .filter((e) => e.qualified && e.id.startsWith('custom:'))
    .sort((a, b) => a.avgMs - b.avgMs)
    .map((e) => e.id)
  const chosen = getPrefs().masterModel
  if (chosen) ids.push(chosen)
  for (const id of ids) {
    const mc = masterClientFor(id)
    if (mc && modelBlockReason(mc.modelId) === null) return mc
  }
  return null
}

const SYSTEM =
  'You extract lasting facts about the USER from one chat turn. Return ONLY JSON: {"facts":[{"title":"...","content":"..."}]}. ' +
  'Rules: use ONLY what the USER said about themselves (preferences, tools/devices they use, standing rules for how you should behave, their role or ongoing context). ' +
  'Never use what the assistant said. Skip one-off tasks, questions, temporary states, opinions about a single answer. ' +
  'Never include passwords, keys, tokens, ID or card numbers, or health details. Max 3 facts, each content under 200 characters, same language as the user (Levantine Arabic stays Levantine). ' +
  'Do not repeat a fact already listed. If nothing lasting was stated return {"facts":[]}.'

let running = false
let lastRun = 0

// What the last attempt did (kept in a small file so a silent "nothing saved" can always be explained).
const note = (outcome: string, extra?: string): number => {
  try {
    writeJson('auto-memory-status.json', { at: Date.now(), outcome, ...(extra ? { extra: extra.slice(0, 300) } : {}) })
  } catch {
    /* diagnostics only */
  }
  return 0
}

export async function autoMemory(a: { userMsg: string; reply: string; confidential: boolean; unattended: boolean }): Promise<number> {
  let mine = false
  try {
    const p = getPrefs()
    if (!p.autoMemoryEnabled) return note('off')
    if (p.learningPaused || a.confidential || a.unattended) return note('skipped: private/confidential/scheduled')
    if (!worthExtracting(a.userMsg)) return note('skipped: nothing lasting stated')
    if (running || Date.now() - lastRun < MIN_GAP_MS) return note('skipped: too soon')
    const mc = await extractorClient()
    if (!mc) return note('no usable cloud model')
    running = true
    mine = true
    lastRun = Date.now()
    const existing = listMemory()
      .map((e) => '- ' + e.title)
      .slice(-40)
      .join('\n')
    try {
      const r = await mc.client.chat.completions.create(
        {
          model: mc.modelId,
          temperature: 0.1,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Already known:\n${existing || '(nothing)'}\n\nUser said:\n${a.userMsg.slice(0, 1500)}\n\nAssistant answered (context only):\n${a.reply.slice(0, 400)}` }
          ]
        },
        { timeout: 30000, maxRetries: 0 }
      )
      noteModelOk(mc.modelId)
      const text = r.choices[0]?.message?.content ?? ''
      const facts = parseFacts(text, [...getBlocked(), ...projectNames()])
      const n = mergeFacts(facts)
      note('ok: ' + facts.length + ' found, ' + n + ' added', facts.length ? undefined : text)
      return n
    } catch (e) {
      noteModelFailure(mc.modelId, e instanceof Error ? e.message : String(e))
      return note('model error', e instanceof Error ? e.message : String(e))
    }
  } catch (e) {
    return note('crashed', e instanceof Error ? e.message : String(e))
  } finally {
    if (mine) running = false
  }
}
