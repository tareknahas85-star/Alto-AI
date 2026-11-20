import { reviewVerdict } from './build-guards'
import { emitAgent } from './progress'
import { runClaudeAgent, runCodexAgent, runGeminiAgent, codexModelOf, CODEX_CLI, CODEX_MODEL_PREFIX, GEMINI_CLI, ENGINE_ORDER, type AgentResult } from './cli-agent'
import OpenAI from 'openai'
import { hostOf } from './hosts'
import { apinexClient, apinexModelId, hasApinexKey, isApinexModel } from './apinex'
import { listCatalog } from './catalog'
import { getRoles } from './roles'
import { CUSTOM_PREFIX, clientForCustomModel, getCustomModel, listCustomModelViews } from './custom-models'
import { WEAK_MODEL } from './reply-quality'

// العيلة: نفس العيلة = ما نعتبر المراجعة مستقلة. الموديل المخصص يتصنّف حسب اسم موديله (claude / gemini / gpt).
const family = (e: string): string => {
  if (e.startsWith(CUSTOM_PREFIX)) {
    const n = (getCustomModel(e.slice(CUSTOM_PREFIX.length))?.model ?? e).toLowerCase()
    return /claude/.test(n) ? 'claude' : /gemini/.test(n) ? 'google' : /gpt|codex|openai|\bo[1-9]\b/.test(n) ? 'openai' : e
  }
  if (e.includes('/') && !e.startsWith('cli:')) { const n = e.toLowerCase(); return /claude|anthropic/.test(n) ? 'claude' : /gemini|google/.test(n) ? 'google' : /gpt|codex|openai|\bo[1-9]\b/.test(n) ? 'openai' : e }
  return e.startsWith('cli:claude') ? 'claude' : (e === CODEX_CLI || e.startsWith(CODEX_MODEL_PREFIX)) ? 'openai' : e === GEMINI_CLI ? 'google' : e
}

export type Ctx = { signal?: AbortSignal; emit: (t: string) => void; effort?: string; cwd?: string; reviewer?: string; trace?: string }

// المراجع عبر API ما عنده وصول للملفات. نقولها له صراحة عشان ما يدّعي إنه فحص شي ما فحصه.
const API_REVIEW_NOTE =
  '\n\nIMPORTANT: you have NO access to files or the machine in this review. Judge from the task, the executor summary and the TOOL TRACE (the real commands and outputs). Say so in the CHECKS line, and never claim you ran or read anything yourself. A trace entry ending with "[cut by the app for length" was only shortened for you: that is NOT a reason to FAIL; judge from what you can see and say if something is unverifiable instead of rejecting.'

async function runApiReview(eng: string, prompt: string, system: string, c: Ctx): Promise<AgentResult> {
  const m = getCustomModel(eng.slice(CUSTOM_PREFIX.length))
  if (!m) throw new Error('موديل المراجعة مو موجود')
  const { client, modelId } = clientForCustomModel(m)
  c.emit('مراجعة نصية (بدون وصول للملفات)')
  const res = await client.chat.completions.create({ model: modelId, messages: [{ role: 'system', content: system + API_REVIEW_NOTE }, { role: 'user', content: prompt }] }, { signal: c.signal })
  const text = res.choices[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('المراجع رجّع رد فاضي')
  return { text, tools: [] } as unknown as AgentResult
}

// مراجع من apinex: نفس المراجعة النصية بدون ملفات.
async function runApinexReview(eng: string, prompt: string, system: string, c: Ctx): Promise<AgentResult> {
  if (!hasApinexKey()) throw new Error('ما في مفتاح apinex للمراجع')
  c.emit('مراجعة نصية (بدون وصول للملفات)')
  const res = await apinexClient().chat.completions.create({ model: apinexModelId(eng), messages: [{ role: 'system', content: system + API_REVIEW_NOTE }, { role: 'user', content: prompt }] }, { signal: c.signal })
  const text = res.choices[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('المراجع رجّع رد فاضي')
  return { text, tools: [] } as unknown as AgentResult
}

// مراجع من كتالوج OpenRouter (Claude/GPT...) مختار من قائمة المراجع: نفس المراجعة النصية بدون ملفات.
async function runOpenRouterReview(eng: string, prompt: string, system: string, c: Ctx): Promise<AgentResult> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('ما في مفتاح OpenRouter للمراجع')
  const client = new OpenAI({ baseURL: hostOf('openrouter'), apiKey: process.env.OPENROUTER_API_KEY, dangerouslyAllowBrowser: true, timeout: 120000, maxRetries: 0 })
  c.emit('مراجعة نصية (بدون وصول للملفات)')
  const res = await client.chat.completions.create({ model: eng, messages: [{ role: 'system', content: system + API_REVIEW_NOTE }, { role: 'user', content: prompt }] }, { signal: c.signal })
  const text = res.choices[0]?.message?.content ?? ''
  if (!text.trim()) throw new Error('المراجع رجّع رد فاضي')
  return { text, tools: [] } as unknown as AgentResult
}

function runOn(eng: string, prompt: string, system: string, c: Ctx, role: string): Promise<AgentResult> {
  if (eng.startsWith(CUSTOM_PREFIX)) return runApiReview(eng, prompt, system, c)
  if (isApinexModel(eng)) return runApinexReview(eng, prompt, system, c)
  if (eng.includes('/') && !eng.startsWith('cli:')) return runOpenRouterReview(eng, prompt, system, c)
  const base = { signal: c.signal, system, cwd: c.cwd, onProgress: (t: string): void => emitAgent(eng, role, t) }
  return eng === CODEX_CLI || codexModelOf(eng) ? runCodexAgent(prompt, { ...base, model: codexModelOf(eng) }) : eng === GEMINI_CLI ? runGeminiAgent(prompt, base) : runClaudeAgent(prompt, { ...base, effort: c.effort })
}

const REVIEW_SYS =
  'You are the single reviewer/verifier of this task. You did NOT execute it. Your only job: confirm the user\'s request was actually carried out correctly, judging by EVIDENCE: the TOOL TRACE (commands that really ran and their outputs) and, if you have file access, the real files. ' +
  'The user\'s explicit instructions in TASK (for example a specific path such as the Desktop) override any default project-folder convention: never flag work for living where the task asked it to live. Ignore unrelated earlier chat history and do not demand extra scope the user did not ask for. ' +
  'If the evidence shows the request was done, answer PASS. If it was not done, is wrong, or the executor claims something the trace does not support, answer FAIL and give the executor precise redo instructions. A tool error followed by a successful retry is fine. ' +
  'Be efficient (at most ~8 commands if you can run any); do not modify any file. Output format, strictly: one line per real issue as "FINDING [high|medium|low]: <issue> | evidence: <command/output/file>", then "CHECKS: <what you actually ran/read>", then, only when FAIL, "REDO: <exact instruction for the executor>", then a final line "VERDICT: PASS" or "VERDICT: FAIL". Answer in simple Levantine Arabic, technical terms in English.'

/** المايسترو (Hydrogen) كمراجع لما يكون مشغّل: بيرجّع معرّف الموديل المخصص إذا موجود. */
export function masterReviewer(): string | undefined {
  const m = listCustomModelViews().find((x) => x.enabled && x.hasKey && /gemini-4-hydrogen/i.test(x.model ?? ''))
  return m ? CUSTOM_PREFIX + m.id : undefined
}

/** سجل الأدوات الفعلي (أوامر + نواتجها) كدليل للمراجع. */
export function traceOf(calls?: { key: string; out: string }[]): string {
  if (!calls?.length) return ''
  const one = (x: { key: string; out: string }): string => { const o = x.out.replace(/\s+/g, ' '); return x.key.slice(0, 220) + ' => ' + o.slice(0, 1500) + (o.length > 1500 ? ' …[cut by the app for length, NOT by the executor]' : '') }
  return calls.slice(-25).map(one).join('\n---\n').slice(-14000)
}

/** تعليمات الإعادة للمنفّذ من حكم المراجع. */
export function redoNote(rv: { text: string }): string {
  const redo = rv.text.split('\n').find((l) => /^\s*REDO:/i.test(l))
  const high = rv.text.split('\n').filter((l) => /^\s*FINDING\s*\[(high|medium)\]/i.test(l)).slice(0, 6).join('\n')
  return '\n\n[REVIEWER REJECTED YOUR PREVIOUS ATTEMPT. Redo the task correctly now and actually run the tools.]\n' + (redo ?? '') + '\n' + high
}

export type ReviewOutcome = { reviewer: string; independent: boolean; text: string; findings: number; high: number; medium: number; verdict: 'PASS' | 'FAIL' | 'UNKNOWN' }

function parse(text: string): { findings: number; high: number; medium: number; verdict: 'PASS' | 'FAIL' | 'UNKNOWN' } {
  return reviewVerdict(text)
}

export async function independentReview(author: string, task: string, authorSummary: string, c: Ctx): Promise<ReviewOutcome | null> {
  // مراجعين: محركات الاشتراك (لو مفعّلة) + الموديلات المخصصة اللي عندها مفتاح. الأقوى أولاً.
  const rank = (t: string): number => (t === 'TIER_3_EXPENSIVE' ? 0 : t === 'TIER_2_CHEAP' ? 1 : 2)
  const apiReviewers = listCustomModelViews()
    .filter((m) => m.enabled && m.hasKey)
    .sort((a, b) => rank(a.tier) - rank(b.tier))
    .map((m) => CUSTOM_PREFIX + m.id)
  // 5.17.8: احتياط تلقائي: Claude/GPT من كتالوج OpenRouter (الأرخص أولاً، واحد من كل عيلة)، بيجي بعد الموديلات المخصصة، فبيشتغل بس لما مراجع من عيلة غير المنفّذ مو متاح (مثلاً المنفّذ Google).
  const orPick = (re: RegExp): string[] =>
    process.env.OPENROUTER_API_KEY
      ? listCatalog()
          .models.filter((m) => re.test(m.id) && m.tier !== 'TIER_1_FREE' && !/:free$/i.test(m.id))
          .sort((a, b) => rank(b.tier) - rank(a.tier) || a.id.localeCompare(b.id))
          .slice(0, 1)
          .map((m) => m.id)
      : []
  const orReviewers = [...orPick(/^anthropic\/claude/i), ...orPick(/^openai\/gpt/i)]
  const others = [...ENGINE_ORDER, ...apiReviewers, ...orReviewers].filter((e) => family(e) !== family(author))
  // Reviewer preference (Settings > roles). It is used only when it comes from a different family than the author.
  // 5.21.16: المراجع المختار (أو المايسترو إذا شغّال) بيتحترم دايماً، حتى لو من نفس عيلة المنفّذ.
  const pref = c.reviewer ?? getRoles().reviewer
  const preferred: string[] = pref !== 'auto' ? [pref] : []
  // الموديلات الخفيفة/المجانية ما بتراجع بثقة: نجرّب القوي من عيلة تانية أولاً، بعدين القوي من نفس العيلة (مع علامة مو مستقل)، وآخر شي الخفيف.
  const isWeakRev = (e: string): boolean => { const n = e.startsWith(CUSTOM_PREFIX) ? (getCustomModel(e.slice(CUSTOM_PREFIX.length))?.model ?? e) : e; const tier = e.startsWith(CUSTOM_PREFIX) ? getCustomModel(e.slice(CUSTOM_PREFIX.length))?.tier : undefined; return WEAK_MODEL.test(n) || tier === 'TIER_1_FREE' || /:free$/i.test(e) }
  const sameFamStrong = apiReviewers.filter((e) => e !== author && family(e) === family(author) && !isWeakRev(e) && !preferred.includes(e))
  const ordered = [...preferred, ...others.filter((e) => !isWeakRev(e) && !preferred.includes(e)), ...sameFamStrong, ...others.filter((e) => isWeakRev(e) && !preferred.includes(e))]
  const candidates = [...new Set([...ordered, author])]
  const body = 'TASK GIVEN TO THE AUTHOR:\n' + task.slice(0, 3000) + '\n\nAUTHOR\'S OWN FINAL SUMMARY (unverified claims):\n' + authorSummary.slice(0, 4000) + (c.trace ? '\n\nTOOL TRACE (real commands and outputs, oldest first):\n' + c.trace : '\n\nTOOL TRACE: none recorded.') + (c.cwd ? '\n\nPROJECT FOLDER (your working directory; write REVIEW-AUTO.md ONLY inside this exact folder, never in any other folder): ' + c.cwd : '')
  for (const eng of candidates) {
    try {
      c.emit('مراجعة مستقلة بواسطة: ' + eng)
      const r = await runOn(eng, body, REVIEW_SYS, c, 'مراجع')
      const p = parse(r.text)
      return { reviewer: eng, independent: family(eng) !== family(author), text: r.text, ...p }
    } catch (e) {
      if (c.signal?.aborted) throw e
    }
  }
  return null
}

export async function repairFromReview(author: string, task: string, review: ReviewOutcome, c: Ctx): Promise<AgentResult | null> {
  try {
    c.emit('إصلاح الملاحظات بعد المراجعة')
    const prompt = 'An independent reviewer found problems in your work on this task:\n' + task.slice(0, 2000) + '\n\nREVIEW:\n' + review.text.slice(0, 5000) + '\n\nFix every real finding in the project (edit existing files, do not rewrite or shrink documents), re-run the verification (typecheck/tests/build/screenshots) and update STATE.md. Finish with an honest summary: what you fixed, what you could not, with command output as proof.'
    return await runOn(author, prompt, '', c, 'منفّذ (إصلاح)')
  } catch (e) {
    if (c.signal?.aborted) throw e
    return null
  }
}
