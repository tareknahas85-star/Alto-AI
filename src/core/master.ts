import { hostOf } from './hosts'
import OpenAI from 'openai'
import { MASTER_MODELS } from './config'
import { listCustomModels, clientForCustomModel } from './custom-models'
import { skillCatalog } from '../skills/loader'
import { emitProgress, currentSignal } from './progress'

const LOCAL_BASE = 'http://127.0.0.1:11434'
export type Analysis = {
  complexity: 'simple' | 'medium' | 'complex'
  type: 'chat' | 'code' | 'research' | 'file_task'
  need_skill: 'none' | 'delegate-coding' | 'delegate-research' | 'delegate-file'
  need_tools: boolean
  reason: string
  skill?: string // optional imported skill picked by the maestro
  source?: string // which maestro answered: local | openrouter | fallback
  masterModel?: string
  allowWeaker?: boolean // set only when the user approved continuing with a lighter model after a strong-model refusal
}


export const SYSTEM_PROMPT =
  'You are a request classifier. Analyze the user request and return ONLY valid JSON without markdown. ' +
  'Format: {"complexity":"simple|medium|complex","type":"chat|code|research|file_task","need_skill":"none|delegate-coding|delegate-research|delegate-file","need_tools":true/false,"reason":"short reason"} ' +
  'Rules: simple=general chat/translation/summary, medium=simple code/explanation, complex=full project/file operations/multi-step. ' +
  'If request mentions code/programming/bug/fix/write function -> need_skill=delegate-coding and need_tools=true. ' +
  'If research/search -> delegate-research. ' +
  'Set need_tools=true also when the user asks for live/system data (CPU, memory, disk, processes), reading files, searching the web, or using an external service or connected app. Also set need_tools=true when the user asks to operate/control the computer: open or close a program, click, type, take a screenshot, run a system command, or manage files on the PC.'

const COMPLEXITIES: Analysis['complexity'][] = ['simple', 'medium', 'complex']
const TYPES: Analysis['type'][] = ['chat', 'code', 'research', 'file_task']
// need_skill values map to folders in src/skills/delegate-skills:
// delegate-coding -> coding/, delegate-research -> research/, delegate-file -> file/ (not created yet)
const SKILLS: Analysis['need_skill'][] = [
  'none',
  'delegate-coding',
  'delegate-research',
  'delegate-file'
]

function fallbackAnalysis(): Analysis {
  return {
    complexity: 'simple',
    type: 'chat',
    need_skill: 'none',
    need_tools: true,
    reason: 'fallback',
    source: 'fallback'
  }
}

let client: OpenAI | null = null
let clientKey: string | undefined

// Created lazily, and re-created if the key changes (e.g. saved from the Settings screen).
function getClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!client || clientKey !== apiKey + hostOf('openrouter')) {
    client = new OpenAI({
      baseURL: hostOf('openrouter'),
      apiKey,
      timeout: 25000, // fail fast so the next maestro model gets a turn
      maxRetries: 0
    })
    clientKey = apiKey + hostOf('openrouter')
  }
  return client
}

export function parseAnalysis(text: string, skillNames: string[] = []): Analysis | null {
  const match = text.match(/\{.*\}/s)
  if (!match) return null

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(match[0])
  } catch {
    return null
  }

  if (
    !COMPLEXITIES.includes(raw.complexity as Analysis['complexity']) ||
    !TYPES.includes(raw.type as Analysis['type']) ||
    !SKILLS.includes(raw.need_skill as Analysis['need_skill']) ||
    typeof raw.need_tools !== 'boolean'
  ) {
    return null
  }

  return {
    complexity: raw.complexity as Analysis['complexity'],
    type: raw.type as Analysis['type'],
    need_skill: raw.need_skill as Analysis['need_skill'],
    need_tools: raw.need_tools,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    skill: typeof raw.skill === 'string' && skillNames.includes(raw.skill) ? raw.skill : undefined
  }
}


const CODEISH =
  /\b(sql|select|function|code|bug|script|python|javascript|typescript|powershell|regex|query|api|docker|kubernetes|terraform|yaml|debug|refactor|compile)\b|كود|دالة|سكربت|سكريبت|استعلام|برمجة/i
const TOOLISH =
  /\b(cpu|ram|memory|disk|process|processes|file|files|folder|directory|search|web|url|github|gcloud|kubectl|terraform|database|table|tables|email|gmail|drive|calendar|canva|outlook|onedrive|onenote|design|miro|notion|box|deepgram|assemblyai|browser-use|filesystem|jira|confluence|gcloud|kubernetes|k8s|terraform|cluster|pod|pods|image|images|picture|draw|hfspace|colab|composio|huggingface)\b|صورة|صور|ارسم|رسم|ولّد|كولاب|كومبوزيو|ميرو|نوشن|جيرا|كلاستر|بورد|خريطة ذهنية|كانفا|تصميم|اوتلوك|ون درايف|مايكروسوفت|ملف|مجلد|ايميل|إيميل|بريد|تقويم|كلندر|موعد|مواعيد|اجتماع|مهام|مهمة|ملاحظ|درايف|جهات الاتصال|مستند|عرض تقديمي|ابحث|بحث|معالج|رام|قرص|جدول|قاعدة بيانات|افتح|شغّل|شغل|اضغط|كبس|اكتب لي على|لقطة شاشة|سكرين|الشاشة|نافذة|برنامج|جهازي|الكمبيوتر|open|click|screenshot|notepad|calc/i

// The small local maestro is lenient-parsed and corrected with a few deterministic rules,
// because a 1.7B model often mislabels the type or puts a skill name in the wrong field.
function parseLocal(text: string, skillNames: string[], input: string, boost?: string): Analysis | null {
  const m = text.match(/\{.*\}/s)
  if (!m) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(m[0])
  } catch {
    return null
  }
  let skill = typeof raw.skill === 'string' ? raw.skill : undefined
  if (typeof raw.need_skill === 'string' && skillNames.includes(raw.need_skill)) skill = raw.need_skill
  if (!skill || !skillNames.includes(skill)) skill = boost && skillNames.includes(boost) ? boost : undefined
  const code = CODEISH.test(input)
  const rawType = TYPES.includes(raw.type as Analysis['type']) ? (raw.type as Analysis['type']) : 'chat'
  const type: Analysis['type'] = code && rawType === 'chat' ? 'code' : rawType
  let complexity = COMPLEXITIES.includes(raw.complexity as Analysis['complexity'])
    ? (raw.complexity as Analysis['complexity'])
    : 'simple'
  if (code && complexity === 'simple' && input.length > 40) complexity = 'medium'
  const delegated = ['delegate-coding', 'delegate-research', 'delegate-file'].includes(String(raw.need_skill))
  const need_skill: Analysis['need_skill'] = code
    ? 'delegate-coding'
    : delegated
      ? (raw.need_skill as Analysis['need_skill'])
      : 'none'
  return {
    complexity,
    type,
    need_skill,
    need_tools: code || TOOLISH.test(input),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    skill
  }
}

export async function warmLocalMaster(): Promise<void> {
  const installed = await installedLocalModels()
  const pick = APPROVED_LOCAL_MASTERS.find((m) => installed.includes(m))
  if (!pick) return
  try {
    await fetch(LOCAL_BASE + '/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: pick, prompt: '', keep_alive: '5m' }),
      signal: AbortSignal.timeout(90000)
    })
  } catch {
    /* ollama busy */
  }
}

// Approved local masters, strongest first. Small models (e.g. qwen3:4b) are never used as the master.
const APPROVED_LOCAL_MASTERS = ['qwen3:32b', 'qwen2.5:32b', 'qwen3:14b', 'qwen2.5:14b', 'gemma3:12b']
// Primary cloud master: used whenever its key is in the app.
const PRIMARY_MASTER = 'gemini-4-hydrogen'

async function installedLocalModels(): Promise<string[]> {
  try {
    const r = await fetch(LOCAL_BASE + '/api/tags', { signal: AbortSignal.timeout(1500) })
    const j = (await r.json()) as { models?: { name: string }[] }
    return (j.models ?? []).map((m) => m.name)
  } catch {
    return []
  }
}

async function tryLocalMaster(userInput: string, system: string, names: string[]): Promise<Analysis | null> {
  const installed = await installedLocalModels()
  const pick = APPROVED_LOCAL_MASTERS.find((m) => installed.includes(m))
  if (!pick) return null
  try {
    emitProgress('الماستر المحلي: ' + pick)
    const cs = currentSignal()
    const r = await fetch(LOCAL_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(cs ? [cs] : [])]),
      body: JSON.stringify({
        model: pick,
        stream: false,
        think: false,
        format: 'json',
        keep_alive: '5m',
        options: { temperature: 0, num_predict: 1000 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userInput }
        ]
      })
    })
    const j = (await r.json()) as { message?: { content?: string } }
    const parsed = parseLocal(j.message?.content ?? '', names, userInput, undefined)
    if (parsed) return { ...parsed, source: 'local', masterModel: pick }
    console.warn('[Master] local master unparseable:', pick)
  } catch (error) {
    console.warn('[Master] local master failed:', pick, error)
  }
  return null
}

export async function analyzeRequest(userInput: string, localOnly = false): Promise<Analysis> {
  let catalog: { name: string; description: string }[] = []
  try {
    catalog = await skillCatalog()
  } catch {
    catalog = []
  }
  const names = catalog.map((c) => c.name)
  emitProgress('الماستر يحلل الطلب…')
  const system = catalog.length
    ? SYSTEM_PROMPT +
      ' Add an optional field "skill": the EXACT name of ONE skill from AVAILABLE_SKILLS only if it clearly fits the request, otherwise omit it or use null. ' +
      'AVAILABLE_SKILLS:\n' +
      catalog.map((c) => `- ${c.name}: ${c.description}`).join('\n')
    : SYSTEM_PROMPT

  if (localOnly) {
    // Confidential project: the request text never goes to a cloud maestro.
    const local = await tryLocalMaster(userInput, system, names)
    if (local) return { ...local, complexity: 'complex' }
    emitProgress('مشروع سري: ما في ماستر محلي قوي، وضع احتياطي')
    return { ...fallbackAnalysis(), complexity: 'complex' }
  }

  // 1) Primary cloud master (gemini-4-hydrogen with the app's key).
  const primary = listCustomModels().find((m) => m.model.includes(PRIMARY_MASTER))
  if (primary) {
    try {
      emitProgress('الماستر: ' + PRIMARY_MASTER)
      const { client, modelId } = clientForCustomModel(primary)
      const completion = await client.chat.completions.create(
        {
          model: modelId,
          temperature: 0.1,
          max_tokens: 1000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userInput }
          ]
        },
        { signal: currentSignal(), timeout: 25000, maxRetries: 0 }
      )
      const parsed = parseAnalysis(completion.choices[0]?.message?.content ?? '', names)
      if (parsed) return { ...parsed, source: 'hydrogen', masterModel: modelId }
      console.warn('[Master] unparseable answer from', modelId)
    } catch (error) {
      // Quota exhausted or any other failure: move on at once, no retries.
      console.warn('[Master] primary master failed, switching:', error)
      emitProgress('الماستر الأساسي ما اشتغل، بنحوّل للاحتياطي')
    }
  }

  // 2) Strongest approved local model installed on this machine.
  const local = await tryLocalMaster(userInput, system, names)
  if (local) return local

  // 3) Cloud fallbacks (OpenRouter chain).
  for (const model of MASTER_MODELS) {
    if (currentSignal()?.aborted) break
    try {
      emitProgress('الماستر (OpenRouter): ' + model)
      const completion = await getClient().chat.completions.create({
        model,
        temperature: 0.1,
        max_tokens: 1000,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userInput }
        ]
      }, { signal: currentSignal() })
      const text = completion.choices[0]?.message?.content ?? ''
      const parsed = parseAnalysis(text, names)
      if (parsed) return { ...parsed, source: 'openrouter', masterModel: model }
      console.warn('[Master] unparseable answer from', model)
    } catch (error) {
      console.warn('[Master] model failed, trying next:', model, error)
    }
  }
  emitProgress('الماستر ما قدر يحلل، الأدوات مفعّلة (وضع احتياطي)')
  return fallbackAnalysis()
}
// --- Simple test (uncomment to try; needs OPENROUTER_API_KEY in the environment) ---
// import 'dotenv/config'
//
// analyzeRequest('اكتبلي function بالـ TypeScript بتعمل sort لمصفوفة أرقام')
//   .then((analysis) => console.log(analysis))
//   .catch(console.error)
