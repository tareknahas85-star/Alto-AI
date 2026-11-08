import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// Low-level ADB access for the Android emulator / device control feature.
// Rules: every adb call uses execFile with an argument array (never a shell string),
// binary output stays binary (Buffer), and inputs are validated before they reach the device.

export const KEYS = { BACK: 4, HOME: 3, RECENTS: 187 } as const
export type KeyName = keyof typeof KEYS

const TIMEOUT_MS = 20000
const INSTALL_TIMEOUT_MS = 180000
const MAX_BUFFER = 32 * 1024 * 1024
const SAFE_TEXT = /^[A-Za-z0-9 .,@_-]{1,200}$/
const SAFE_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

export function sdkRoot(): string | null {
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
  ]
  for (const r of roots) if (r && existsSync(r)) return r
  return null
}

function findAdb(): string {
  if (process.env.ADB_PATH && existsSync(process.env.ADB_PATH)) return process.env.ADB_PATH
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const root = sdkRoot()
  if (root) {
    const p = join(root, 'platform-tools', exe)
    if (existsSync(p)) return p
  }
  return exe // fall back to PATH
}

let adbPath: string | null = null
const adb = (): string => (adbPath ??= findAdb())

function run(args: string[], timeout = TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      adb(),
      args,
      { encoding: 'buffer', timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err)
          reject(
            new Error(
              `adb ${args[0]} failed: ${(stderr?.toString() || err.message).trim().slice(0, 300)}`
            )
          )
        else resolve(stdout as Buffer)
      }
    )
  })
}

// Target device: ANDROID_SERIAL if set, otherwise the single online device.
let serialCache: string | null = null
export async function resolveSerial(): Promise<string> {
  if (serialCache) return serialCache
  const env = process.env.ANDROID_SERIAL?.trim()
  if (env) return (serialCache = env)
  const out = (await run(['devices'])).toString('utf8')
  const online = out
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device')
    .map((p) => p[0])
  if (online.length === 0) throw new Error('no Android device online (start the emulator first)')
  if (online.length > 1)
    throw new Error(`more than one device online (${online.join(', ')}); set ANDROID_SERIAL`)
  return (serialCache = online[0])
}

export function resetDeviceCache(): void {
  serialCache = null
  sizeCache = null
}

const sh = async (args: string[], timeout?: number): Promise<Buffer> =>
  run(['-s', await resolveSerial(), ...args], timeout)

let sizeCache: { w: number; h: number } | null = null
export async function screenSize(): Promise<{ w: number; h: number }> {
  if (sizeCache) return sizeCache
  const out = (await sh(['shell', 'wm', 'size'])).toString('utf8')
  const m = out.match(/(\d+)x(\d+)/)
  if (!m) throw new Error('could not read screen size')
  return (sizeCache = { w: Number(m[1]), h: Number(m[2]) })
}

export async function status(): Promise<{
  connected: boolean
  serial?: string
  size?: { w: number; h: number }
  error?: string
}> {
  try {
    const serial = await resolveSerial()
    return { connected: true, serial, size: await screenSize() }
  } catch (e) {
    return { connected: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// PNG bytes, read as binary (exec-out, no text decoding).
export async function screenshotPng(): Promise<Buffer> {
  const buf = await sh(['exec-out', 'screencap', '-p'])
  const sig = [0x89, 0x50, 0x4e, 0x47]
  if (buf.length < 8 || !sig.every((b, i) => buf[i] === b))
    throw new Error('screenshot did not return a PNG')
  return buf
}

export async function screenshotDataUrl(): Promise<string> {
  return 'data:image/png;base64,' + (await screenshotPng()).toString('base64')
}

// UI hierarchy as XML, written to the terminal device so no file is left on the phone.
export async function uiTreeXml(): Promise<string> {
  // The first dump can fail while an app is still launching, so retry once after a short wait.
  try {
    return await uiTreeXmlOnce()
  } catch {
    await new Promise((r) => setTimeout(r, 1500))
    return uiTreeXmlOnce()
  }
}

async function uiTreeXmlOnce(): Promise<string> {
  const raw = (await sh(['exec-out', 'uiautomator', 'dump', '/dev/tty'])).toString('utf8')
  const xmlStart = raw.indexOf('<?xml')
  const start = xmlStart >= 0 ? xmlStart : raw.indexOf('<hierarchy')
  if (start < 0) throw new Error('uiautomator returned no hierarchy')
  const endTag = '</hierarchy>'
  const end = raw.lastIndexOf(endTag)
  if (end < 0) throw new Error('uiautomator hierarchy is incomplete')
  return raw.slice(start, end + endTag.length)
}

export async function tap(x: number, y: number): Promise<void> {
  const { w, h } = await screenSize()
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) {
    throw new Error(`coordinates out of range (screen is ${w}x${h})`)
  }
  await sh(['shell', 'input', 'tap', String(x), String(y)])
}

// Only a small safe alphabet goes to `input text`; spaces become %s, which is what the device expects.
export async function typeText(text: string): Promise<void> {
  if (!SAFE_TEXT.test(text))
    throw new Error('text must be 1-200 chars of letters, digits, spaces or . , @ _ -')
  await sh(['shell', 'input', 'text', text.replace(/ /g, '%s')])
}

export async function pressKey(key: KeyName): Promise<void> {
  const code = KEYS[key]
  if (code === undefined) throw new Error('unsupported key')
  await sh(['shell', 'input', 'keyevent', String(code)])
}

export async function installApk(apkPath: string): Promise<string> {
  if (!apkPath.toLowerCase().endsWith('.apk') || !existsSync(apkPath))
    throw new Error('APK file not found')
  const out = (await sh(['install', '-r', apkPath], INSTALL_TIMEOUT_MS)).toString('utf8')
  if (!/Success/.test(out)) throw new Error('install failed: ' + out.trim().slice(0, 300))
  return 'installed'
}

export async function launchPackage(pkg: string): Promise<void> {
  if (!SAFE_PACKAGE.test(pkg)) throw new Error('invalid package name (example: com.example.app)')
  await sh(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'])
}

export async function isBooted(): Promise<boolean> {
  try {
    return (await sh(['shell', 'getprop', 'sys.boot_completed'])).toString('utf8').trim() === '1'
  } catch {
    return false
  }
}

export async function killEmulator(): Promise<void> {
  await sh(['emu', 'kill'])
}
