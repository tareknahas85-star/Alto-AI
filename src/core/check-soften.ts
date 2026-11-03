// Turns raw provider error text from a model test into something that doesn't look like a broken key:
// quota/rate-limit (429) means the model isn't in the free tier (or its quota ran out) -> neutral "skip";
// a timeout means slow/busy -> still a fail, but with a message that says to retry.
export type CheckState = 'ok' | 'fail' | 'skip'

export function softenCheck(r: { state: CheckState; message: string }): { state: CheckState; message: string } {
  if (r.state !== 'fail') return r
  const m = r.message
  if (/\b429\b|quota|RESOURCE_EXHAUSTED|rate.?limit|billing/i.test(m)) {
    return { state: 'skip', message: 'مو مجاني أو خلصت حصتو (429) — المفتاح سليم' }
  }
  if (/timed? ?out|timeout|ما رد بالوقت/i.test(m)) {
    return { state: 'fail', message: 'بطيء أو مزحوم هلأ — أعد المحاولة' }
  }
  return r
}
export type Tone = 'ok' | 'soft' | 'fail'

// Same rule for single-model test buttons: 429/quota -> neutral grey, timeout -> retry hint, real errors stay red.
export function toneOf(ok: boolean, message: string): { tone: Tone; message: string } {
  const r = softenCheck({ state: ok ? 'ok' : 'fail', message })
  return { tone: r.state === 'ok' ? 'ok' : r.state === 'skip' ? 'soft' : 'fail', message: r.message }
}
