// Order of the user's own (custom) models inside one tier.
// Before: the order they happen to sit in the file, so the first imported model (often the heaviest and slowest) answered every simple request.
// Now: light models first for simple/medium requests, heavy ones first for complex requests; models that failed the last scan go last;
// the same endpoint imported twice is tried once.
export type Prefer = 'light' | 'strong'
export type ScanLite = { qualified?: boolean; error?: string; avgMs?: number }

// 0 = lightest ... 3 = heaviest. A name heuristic only: the scan result decides between models of the same weight.
export function heft(model: string): number {
  const m = String(model ?? '').toLowerCase()
  if (/(carbon|[-_.]pro(?![a-z])|opus|sonnet|ultra|max(?![a-z])|thinking)/.test(m)) return 3
  if (/(^|[-_.:/ ])(lite|nano(?!-banana)|mini|haiku|small|tiny)(?![a-z])/.test(m)) return 0 // word match: "gemini" must not count as "mini"
  if (/flash/.test(m)) return 1
  return 2
}

type Item = { id: string; model: string; baseURL?: string }

// How good the last scan says a model is: 0 = qualified, 1 = never scanned, 2 = scanned but failed or errored.
const scanRank = (s: ScanLite | undefined): number => (!s ? 1 : s.error ? 2 : s.qualified ? 0 : 2)

export function orderCustom<T extends Item>(items: T[], prefer: Prefer, scan: (id: string) => ScanLite | undefined): T[] {
  // One entry per endpoint+model: keep the one the scan likes best (else the first).
  const byKey = new Map<string, { item: T; i: number }>()
  items.forEach((item, i) => {
    const k = `${(item.baseURL ?? '').toLowerCase()}|${item.model.toLowerCase()}`
    const cur = byKey.get(k)
    if (!cur || scanRank(scan(item.id)) < scanRank(scan(cur.item.id))) byKey.set(k, { item, i: cur ? cur.i : i })
  })
  const uniq = [...byKey.values()]
  const w = (x: { item: T }): number => heft(x.item.model)
  const ms = (x: { item: T }): number => scan(x.item.id)?.avgMs || Number.MAX_SAFE_INTEGER
  uniq.sort((a, b) => {
    const dh = prefer === 'light' ? w(a) - w(b) : w(b) - w(a)
    if (dh) return dh
    const dr = scanRank(scan(a.item.id)) - scanRank(scan(b.item.id))
    if (dr) return dr
    const dm = ms(a) - ms(b)
    if (dm) return dm
    return a.i - b.i
  })
  return uniq.map((x) => x.item)
}
