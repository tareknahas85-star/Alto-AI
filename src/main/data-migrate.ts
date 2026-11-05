import { app } from 'electron'
import { basename, join } from 'path'
import fs from 'fs'

// Alto AI: the app used to keep its data in %APPDATA%\TRL_AI_Agent. On first launch we copy it (once) to the new
// folder. The old folder is left untouched as a safety copy. Copy goes to a temp dir first, then it's renamed,
// so a half-finished copy can never be mistaken for a complete one.
const OLD = 'TRL_AI_Agent'
const NEW = 'Alto AI'
const SKIP = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'blob_storage', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'])

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    try {
      if (ent.isDirectory()) copyTree(s, d)
      else if (ent.isFile()) fs.copyFileSync(s, d)
    } catch {
      /* a locked/unreadable file shouldn't stop the migration */
    }
  }
}

export function setupUserData(): void {
  app.setName(NEW)
  const base = app.getPath('appData')
  const newDir = join(base, NEW)
  const oldDir = join(base, OLD)
  app.setPath('userData', newDir)
  try {
    if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return
    const tmp = newDir + '.migrating'
    fs.rmSync(tmp, { recursive: true, force: true })
    copyTree(oldDir, tmp)
    fs.renameSync(tmp, newDir)
  } catch (e) {
    console.error('userData migration failed:', basename(String(e)))
  }
}