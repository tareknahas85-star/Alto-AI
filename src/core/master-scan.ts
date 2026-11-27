import { readJson, writeJson } from './json-store'
import { runModel, type ModelResult } from './master-test'
import { masterClientFor } from './master'
import { listCustomModelViews, CUSTOM_PREFIX } from './custom-models'
import { CLAUDE_CLI_MODELS, claudeCliPath } from './cli-models'
import { subscriptionEnginesEnabled } from './feature-flags'
import { clearModelBlock } from './model-health'
import { isLocalBaseURL } from './local-guard'
import { qualifies } from './master-qualify'

// Manual master scan ("افحص الموديلات"). It runs the 20-question master test on the models that have a key or a signed-in account
// (never the local ones, never the OpenRouter/apinex free pools: their daily caps are too small to spend on a test),
// stores a score per model, and marks the ones good enough to be the master. Nothing runs at startup: the user presses the button
// (a VPN may take a while to come up after boot).
export type ScanEntry = {
  id: string
  label: string
  total: number
  parsed: number
  tools: number
  type: number
  errors: number
  avgMs: number
  at: number
  qualified: boolean
  error?: string
}
type ScanFile = { at: number; entries: Record<string, ScanEntry> }

const FILE = 'master-scan.json'
const MAX_MODELS = 8

export function loadScan(): ScanFile {
  const r = readJson<Partial<ScanFile>>(FILE, {})
  return { at: r.at ?? 0, entries: r.entries ?? {} }
}

export function scanTargets(): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = []
  // Claude through the signed-in work account (weekly quota, no API credit). Haiku is skipped: it never qualifies and costs quota.
  if (subscriptionEnginesEnabled() && claudeCliPath()) {
    for (const x of CLAUDE_CLI_MODELS) if (!/haiku/i.test(x.id)) out.push({ id: x.id, label: x.label })
  }
  for (const m of listCustomModelViews()) {
    if (!m.enabled || isLocalBaseURL(m.baseURL)) continue
    if (!m.hasKey && m.auth !== 'google') continue
    out.push({ id: CUSTOM_PREFIX + m.id, label: m.name })
  }
  return out.slice(0, MAX_MODELS)
}

type State = { running: boolean; cancelled: boolean; total: number; done: number; current: string; error?: string }
let st: State = { running: false, cancelled: false, total: 0, done: 0, current: '' }

export function scanStatus(): State & { at: number; entries: ScanEntry[] } {
  const f = loadScan()
  return { ...st, at: f.at, entries: Object.values(f.entries) }
}

export function cancelScan(): void {
  if (st.running) st.cancelled = true
}

export function clearScan(): void {
  if (!st.running) writeJson(FILE, { at: 0, entries: {} })
}

async function online(): Promise<boolean> {
  const ping = (url: string): Promise<boolean> =>
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(6000) }).then(
      (r) => r.status < 500,
      () => false
    )
  const results = await Promise.all([ping('https://www.gstatic.com/generate_204'), ping('https://openrouter.ai/api/v1/models')])
  return results.some(Boolean)
}

const num0 = (v: unknown): number => (typeof v === 'number' ? v : 0)

function toEntry(t: { id: string; label: string }, r: ModelResult): ScanEntry {
  const s = r.summary
  // When every call failed the summary has no error of its own: surface the first real cause so the list can show it.
  const firstRowErr = r.rows.find((x) => x.error)?.error
  const err = typeof s.error === 'string' ? s.error : num0(s.errors) > 0 && num0(s.errors) >= num0(s.total) ? firstRowErr : undefined
  const num = (k: string): number => (typeof s[k] === 'number' ? (s[k] as number) : 0)
  const parsed = num('parsed')
  const tools = num('toolsCorrect')
  return {
    id: t.id,
    label: t.label,
    total: num('total'),
    parsed,
    tools,
    type: num('typeCorrect'),
    errors: num('errors'),
    avgMs: num('avgMs'),
    at: Date.now(),
    qualified: qualifies(parsed, tools, err),
    ...(err ? { error: err } : {})
  }
}

export async function startScan(): Promise<{ ok: boolean; error?: string }> {
  if (st.running) return { ok: false, error: 'الفحص شغّال أصلاً' }
  if (!(await online())) return { ok: false, error: 'ما في اتصال بالإنترنت (أو الـ VPN لسا ما اشتغل). جرّب بعد شوي' }
  const targets = scanTargets()
  if (!targets.length) return { ok: false, error: 'ما في موديلات إلها مفتاح أو حساب مسجّل لتتفحّص' }
  st = { running: true, cancelled: false, total: targets.length, done: 0, current: '' }
  void (async () => {
    try {
      const file = loadScan()
      for (const t of targets) {
        if (st.cancelled) break
        st.current = t.label
        // The user asked for a fresh look: forget an old block (e.g. a key that was fixed since).
        clearModelBlock(t.id)
        const mc = masterClientFor(t.id)
        if (mc) clearModelBlock(mc.modelId)
        const r = await runModel(t.id, { cancelled: () => st.cancelled, budgetMs: t.id.startsWith('cli:') ? 300000 : 100000 })
        if (st.cancelled) break
        file.entries[t.id] = toEntry(t, r)
        file.at = Date.now()
        writeJson(FILE, file)
        st.done++
      }
    } catch (e) {
      st.error = e instanceof Error ? e.message.slice(0, 200) : String(e)
    } finally {
      st.running = false
      st.current = ''
    }
  })()
  return { ok: true }
}
