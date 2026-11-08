import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import * as adb from '../tools/android-controller'

// Runs the Android emulator in the background (no window) so the app can show it inside its own panel.
// Started automatically when a Gemini key is set, and at app start when a key is already saved.
// Only the emulator this app started is stopped on quit.

let child: ChildProcess | null = null
let ownStarted = false
let starting: Promise<boolean> | null = null
let lastError = ''

function emulatorExe(): string | null {
  const root = adb.sdkRoot()
  if (!root) return null
  const exe = join(root, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator')
  return existsSync(exe) ? exe : null
}

// AVD names come from the .ini files in the AVD folder. ANDROID_AVD_NAME picks one explicitly.
export function listAvds(): string[] {
  const dir = process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android', 'avd')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ini'))
    .map((f) => f.slice(0, -4))
}

function pickAvd(): string | null {
  const wanted = process.env.ANDROID_AVD_NAME?.trim()
  const all = listAvds()
  if (wanted) return all.includes(wanted) ? wanted : null
  return all[0] ?? null
}

async function waitForBoot(timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    adb.resetDeviceCache()
    if (await adb.isBooted()) return true
    await new Promise((r) => setTimeout(r, 3000))
  }
  return false
}

export async function startAndroidEmulator(): Promise<boolean> {
  if (starting) return starting
  starting = (async () => {
    try {
      if ((await adb.status()).connected) return true
      const exe = emulatorExe()
      if (!exe) { lastError = 'Android SDK emulator not found'; return false }
      const avd = pickAvd()
      if (!avd) { lastError = 'no Android virtual device (AVD) found'; return false }
      child = spawn(
        exe,
        ['-avd', avd, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save', '-gpu', 'swiftshader_indirect'],
        { detached: true, stdio: 'ignore', windowsHide: true }
      )
      child.unref()
      ownStarted = true
      lastError = ''
      const ok = await waitForBoot(240000)
      if (!ok) lastError = 'emulator did not finish booting in time'
      return ok
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      starting = null
    }
  })()
  return starting
}

export function emulatorStartError(): string {
  return lastError
}

// Stops the emulator only if this app started it.
export async function stopAndroidEmulator(): Promise<void> {
  if (!ownStarted) return
  try { await adb.killEmulator() } catch { /* already stopped */ }
  try { child?.kill() } catch { /* ignore */ }
  ownStarted = false
  child = null
  adb.resetDeviceCache()
}
