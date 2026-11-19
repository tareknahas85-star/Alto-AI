// 5.21.18: تقدير قدرات الموديل من اسمو ومستواه، لقائمة الموديلات (مو قياس فعلي).
export type Caps = { tools: 'yes' | 'weak' | 'no' | 'maybe'; kind: string; note: string }

const STRONG = /claude|sonnet|opus|gpt-?[4-9]|\bo[34]\b|codex|gemini[-\w.]*pro|kimi|glm-5\.\d(?!-flash)|deepseek-v\d[-\w.]*pro|qwen-?3\.\d-max|mimo[-\w.]*pro|hydrogen|ultra/i
const LIGHT = /flash|lite|mini|nano|nemo|small|tiny|lightning|spark|\bhy4\b/i

export function modelCaps(value: string, label: string, tier: string): Caps {
  const s = (value + ' ' + label).toLowerCase()
  const kind = /coder|code|codex/.test(s) ? 'برمجة' : /\bvl\b|vision|omni|image|-vl/.test(s) ? 'صور' : /reason|think|\br1\b/.test(s) ? 'تفكير عميق' : LIGHT.test(s) ? 'سريع' : 'عام'
  if (/(^|[^\d.])(0\.\d|[1-3](\.\d)?)b\b/.test(s)) return { tools: 'no', kind: 'محادثة بسيطة', note: 'موديل صغير جداً: بيجاوب أسئلة بسيطة، ما بيمسك أدوات.' }
  if (tier === 'LOCAL') return { tools: 'weak', kind, note: 'موديل محلي: الأدوات حسب حجمو، الأفضل للأسئلة العادية.' }
  if (/openrouter/.test(s) && /free|:free/.test(s)) return { tools: 'no', kind, note: 'مجاني على OpenRouter: غالباً المزوّد بيرفض الأدوات، بيجاوب نص بس.' }
  if (STRONG.test(s) && !/flash|lite|mini|nano/.test(s)) return { tools: 'yes', kind, note: 'موديل قوي: بيمسك أدوات الجهاز والملفات.' }
  if (LIGHT.test(s)) return { tools: 'weak', kind, note: 'موديل خفيف: ممكن يستعمل أدوات بسيطة وما بينفّذ مهام طويلة بثقة.' }
  return { tools: 'maybe', kind, note: 'ما في معلومة مؤكدة عن دعمو للأدوات، جرّبو بمهمة صغيرة.' }
}
