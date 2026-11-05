// Desktop Copilot "hands": which apps the agent may type/click into without an extra, always-on confirmation.
// Pure + tested. Full Access / auto-approve never skip the confirmation for apps outside the allowed list.

/** Never driven by the agent: credential stores and system-level editors. */
export const BLOCKED_APPS = /^(keepass|keepassxc|bitwarden|1password|lastpass|dashlane|enpass|nordpass|regedit|gpedit|secpol|lusrmgr|diskpart|mmc)/i

/** Common apps where typing/clicking is low risk. Everything else asks every single time. */
export const DEFAULT_ALLOWED = [
  'notepad', 'notepad++', 'calculator', 'calculatorapp', 'win32calc', 'calc', 'mspaint', 'paintstudio.view', 'wordpad', 'winword', 'excel', 'powerpnt', 'onenote',
  'chrome', 'msedge', 'firefox', 'brave', 'explorer', 'code', 'snippingtool', 'screensketch', 'alto-ai', 'claude'
]

export type AppClass = 'blocked' | 'allowed' | 'confirm'

export function classifyApp(proc: string, extraAllowed: string[] = []): AppClass {
  const p = (proc || '').trim().toLowerCase().replace(/\.exe$/, '')
  if (!p) return 'confirm'
  if (BLOCKED_APPS.test(p)) return 'blocked'
  const ok = new Set([...DEFAULT_ALLOWED, ...extraAllowed.map((x) => String(x).trim().toLowerCase().replace(/\.exe$/, ''))])
  return ok.has(p) ? 'allowed' : 'confirm'
}
