// 5.21.8: «موافقة وحدة بتكفي» + وضع التفويض.
// المشكلة: لما المستخدم يرد على سؤال الموديل بـ «لا مافي تعديلات بلش» أو «اي نفذ»، الرسالة قصيرة فكانت تنحسب دردشة بسيطة
// وتروح لموديل بدون أدوات، فيرجع الموديل يعرض الخطة ويسأل من جديد. هون منكتشف الموافقة ومنكمّل على الطلب الأصلي.
export type Turn = { role: 'user' | 'assistant'; content: string }

const norm = (s: string): string =>
  (s ?? '')
    .replace(/[\u064B-\u0652\u0640]/g, '') // تشكيل وتطويل
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[.!؟?،,…\s]+/g, ' ')
    .trim()
    .toLowerCase()

// موافقة/إذن بالتنفيذ (رد قصير على سؤال أو خطة).
const GO_RE =
  /(^|\s)(بلش|بلشي|ابدا|ابدء|كمل|كملي|نفذ|نفذي|يلا|يالله|امشي|ماشي|موافق|اوك|اوكي|okay|ok|go|yes|يس|اي|ايه|ايوه|اكيد|تمام|طيب|خلص|اعتمد|عتمد|ساوي|سويها|اعملها|عملها|متل ما بدك|متل ما قلت|ما عندي|ماعندي|ما في|مافي|لا ماعندي|لا ما عندي|لا مافي|بدون تعديل|بلا تعديل)(\s|$)/

// نفي حقيقي يعني «لا توقف»، مو «لا ما عندي تعديل».
const STOP_RE = /(^|\s)(لا تبلش|لا تنفذ|لا تكمل|وقف|استنى|استني|انتظر|لحظة|ما بدي|مابدي|الغي|الغ|بطلت|cancel|stop|wait)(\s|$)/

// تفويض كامل للمحادثة: كمّل لحالك وما ترجعلي إلا بشي مهم كتير.
const DELEGATE_RE =
  /(عندك (ال)?صلاحي[هة]( (ال)?كامل[هة])?|صلاحي[هة] كامل[هة]|مفوض|فوضتك|بفوضك|كمل لحالك|اشتغل لحالك|لا ترجعلي|ما ترجعلي|بدون ما ترجعلي|بلا ما ترجعلي|ما تسالني|لا تسالني|بدون ما تسالني|خلص كلشي|كمل كلشي|نفذ كلشي|full (permission|access|control)|do it all|don'?t ask)/

const LONG = 160
// سؤال (شو/ليش/كيف/وين…) مو موافقة، حتى لو فيه «طيب» أو «بلش».
const QUESTION_RE = /[؟?]|(^|\s)(شو|ليش|ليه|كيف|شلون|وين|مين|قديش|اديش|ايمت|امتى|هل|لشو|why|what|how|where|when|which)(\s|$)/

/** رسالة قصيرة معناها «إي، كمّل/نفّذ» (مو طلب جديد). */
export function isGoAhead(input: string, history: Turn[] = []): boolean {
  const s = norm(input)
  if (!s || s.length > LONG) return false
  if (STOP_RE.test(s)) return false
  if (DELEGATE_RE.test(s)) return true
  if (QUESTION_RE.test((input ?? '').trim()) || QUESTION_RE.test(s)) return false
  if (!GO_RE.test(s)) return false
  // لازم يكون في شي قبلها نكمّل عليه (رد للموديل).
  return history.some((h) => h.role === 'assistant' && h.content.trim().length > 0)
}

/** المستخدم فوّض المحادثة (بهالرسالة أو برسالة قبل). */
export function isDelegated(input: string, history: Turn[] = []): boolean {
  if (DELEGATE_RE.test(norm(input))) return true
  return history.some((h) => h.role === 'user' && DELEGATE_RE.test(norm(h.content)))
}

/** آخر طلب حقيقي من المستخدم (مو موافقة قصيرة)، لنكمّل عليه. */
export function carriedRequest(history: Turn[] = []): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (h.role !== 'user') continue
    const t = h.content.trim()
    if (t && !isGoAhead(t, history.slice(0, i))) return t.slice(0, 2000)
  }
  return ''
}

/** النص يلي منحلّل فيه الطلب (أدوات؟ ملفات؟ بحث؟): الموافقة القصيرة بتورث طلبها الأصلي. */
export function routingInput(input: string, history: Turn[] = []): string {
  if (!isGoAhead(input, history)) return input
  const prev = carriedRequest(history)
  return prev ? prev + '\n' + input : input
}

/** الرسالة يلي بتوصل للموديل: الموافقة القصيرة + الطلب الأصلي صريح، لحتى ما يضيع ويروح يدوّر بالجهاز شو المطلوب. */
export function modelInput(input: string, history: Turn[] = []): string {
  if (!isGoAhead(input, history)) return input
  const prev = carriedRequest(history)
  if (!prev) return input
  return input + '\n\n[APP NOTE: this reply approves the earlier request. The task to execute now is exactly this one, nothing else: «' + prev + '». Follow the plan already agreed in this conversation. Do not search the computer for what to do.]'
}

export const ONE_CONFIRM_HINT =
  '\n\nONE CONFIRMATION IS ENOUGH: if you already proposed a plan/options and the user answered yes / start / go ahead / "no changes", that IS the approval. ' +
  'Never ask the same question again ("any changes?", "shall I start?", "do you want me to…?") and never re-present the same plan. Execute it with your tools and report the real result.'

export const GO_AHEAD_HINT =
  '\n\nTHE USER JUST APPROVED. Their last message is a go-ahead for what you proposed earlier in this conversation. ' +
  'Do the agreed work NOW, completely, in this turn, using your tools. Do not restate the plan, do not offer alternatives, do not ask for confirmation. ' +
  'If a step needs a choice, pick the sensible default yourself and mention it in one line at the end.'

export const DELEGATED_HINT =
  '\n\nDELEGATED: the user gave you full authority for this conversation. Keep working through ALL remaining steps on your own without checking in. ' +
  'Stop and ask ONLY before something irreversible and destructive (deleting or overwriting the user\'s files/data, formatting or wiping a disk / SD card / USB, uninstalling, force-push, sending money) ' +
  'or when you need a secret only the user has (password, key). Everything else: decide sensibly, continue, and give one final report with evidence.'

/** التعليمات الإضافية للموديل حسب حالة المحادثة. */
export function delegationHint(input: string, history: Turn[] = []): string {
  let s = ONE_CONFIRM_HINT
  if (isGoAhead(input, history)) s += GO_AHEAD_HINT
  if (isDelegated(input, history)) s += DELEGATED_HINT
  return s
}