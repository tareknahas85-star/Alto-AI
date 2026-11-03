import type OpenAI from 'openai'
import { addComputerTools, computerEnabled, runVoiceApproved } from '../computer/control'

// أدوات الجهاز المباشرة لـ Gemini Live (سعاد): بدون ما تمرّ على الماستر. نفس أدوات pc_* ونفس الحراس،
// بس الموافقات بتصير بالصوت: الأداة بترجّع needs_confirmation، سعاد بتسألك، وإذا قلت «إي» بتنادي الأداة تاني مع confirmed=true.

type Handler = (a: Record<string, unknown>) => Promise<string>
const ALLOWED = ['pc_windows', 'pc_active_window', 'pc_open', 'pc_focus', 'pc_type', 'pc_keys', 'pc_click', 'pc_scroll', 'pc_ui_snapshot', 'pc_ocr', 'pc_list_dir', 'pc_read_file', 'pc_close_app']

let reg: { defs: OpenAI.Chat.ChatCompletionTool[]; handlers: Map<string, Handler> } | null = null
function registry(): { defs: OpenAI.Chat.ChatCompletionTool[]; handlers: Map<string, Handler> } {
  if (!reg) {
    const defs: OpenAI.Chat.ChatCompletionTool[] = []
    const handlers = new Map<string, Handler>()
    addComputerTools(defs, handlers)
    reg = { defs, handlers }
  }
  return reg
}

export function liveToolDecls(): Record<string, unknown>[] {
  if (!computerEnabled()) return []
  const out: Record<string, unknown>[] = []
  for (const d of registry().defs) {
    if (d.type !== 'function' || !ALLOWED.includes(d.function.name)) continue
    const params = (d.function.parameters ?? {}) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] }
    const props: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params.properties ?? {})) props[k] = { type: String(v.type ?? 'string').toUpperCase(), ...(v.description ? { description: v.description } : {}) }
    props.confirmed = { type: 'BOOLEAN', description: 'true فقط بعد ما سألتي المستخدم وقال «أوكي» بصوتو. ممنوع تحطيها بدون سؤال.' }
    out.push({ name: d.function.name, description: (d.function.description ?? '').slice(0, 400), parameters: { type: 'OBJECT', properties: props, required: params.required ?? [] } })
  }
  return out
}

export async function runLiveTool(name: string, args: Record<string, unknown>, heardYes: () => Promise<boolean>): Promise<string> {
  if (!computerEnabled()) return 'التحكم بالجهاز مطفي. بيتفعّل من صفحة الإضافات (التحكم بالجهاز).'
  const h = ALLOWED.includes(name) ? registry().handlers.get(name) : undefined
  if (!h) return 'Error: أداة غير معروفة: ' + name
  const confirmed = args.confirmed === true
  if (confirmed && !(await heardYes())) return 'ما سمعت موافقة المستخدم. اسأليه من جديد وانتظري جوابو قبل ما تنادي الأداة.'
  const rest = { ...args }
  delete rest.confirmed
  try {
    const { result, pending } = await runVoiceApproved(confirmed, () => h(rest))
    if (pending) {
      if (!pending.voiceOk) return 'هالإجراء حسّاس وبيحتاج تأكيد من نافذة البرنامج، ما بيتأكد بالصوت. قولي للمستخدم يوافق من الشاشة.'
      return JSON.stringify({
        needs_confirmation: true,
        action: pending.title + ' — ' + pending.detail,
        instruction: 'اسألي المستخدم بجملة قصيرة إذا موافق. قوليلو: قول «أوكي» إذا موافق. إذا قال «أوكي» نادي نفس الأداة بنفس الباراميترات مع confirmed=true. إذا قال لا، ما تنفذي.',
      })
    }
    return result
  } catch (e) {
    return 'Error: ' + (e instanceof Error ? e.message : String(e))
  }
}
