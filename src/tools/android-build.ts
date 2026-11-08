import { execFile } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { sdkRoot } from './android-controller'

// Builds a debug APK with the project's Gradle wrapper and returns the newest APK it produced.
// Runs project code, so the caller must get the user's approval first.

const BUILD_TIMEOUT_MS = 20 * 60 * 1000
const MAX_BUFFER = 16 * 1024 * 1024
const SKIP = new Set(['node_modules', '.gradle', '.git', 'build'])

function newestApk(dir: string, depth = 0): string | null {
  if (depth > 7 || !existsSync(dir)) return null
  let best: { p: string; t: number } | null = null
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (SKIP.has(name) && name !== 'build') continue
      const inner = newestApk(p, depth + 1)
      if (inner) {
        const t = statSync(inner).mtimeMs
        if (!best || t > best.t) best = { p: inner, t }
      }
    } else if (
      name.endsWith('.apk') &&
      /[\\/]outputs[\\/]apk[\\/]/.test(p) &&
      (!best || st.mtimeMs > best.t)
    ) {
      best = { p, t: st.mtimeMs }
    }
  }
  return best?.p ?? null
}

export async function buildDebugApk(projectPath: string): Promise<{ apk: string; log: string }> {
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory())
    throw new Error('project folder not found')
  const win = process.platform === 'win32'
  const wrapper = join(projectPath, win ? 'gradlew.bat' : 'gradlew')
  if (!existsSync(wrapper)) throw new Error('no Gradle wrapper in this project (gradlew not found)')
  const env = { ...process.env }
  const root = sdkRoot()
  if (root) {
    env.ANDROID_HOME = root
    env.ANDROID_SDK_ROOT = root
  }
  const gradleArgs = ['assembleDebug', '--console=plain', '--no-daemon']
  const [cmd, args] = win ? ['cmd', ['/c', 'gradlew.bat', ...gradleArgs]] : [wrapper, gradleArgs]
  const log = await new Promise<string>((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: projectPath,
        env,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true
      },
      (err, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`
        if (err) reject(new Error('build failed: ' + text.trim().slice(-1500)))
        else resolve(text)
      }
    )
  })
  const apk = newestApk(projectPath)
  if (!apk) throw new Error('build finished but no debug APK was found')
  return { apk, log: log.trim().slice(-800) }
}
