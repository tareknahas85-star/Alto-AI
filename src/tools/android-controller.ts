import { execFile, spawn, type ChildProcess } from 'child_process'
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

// Used by the live stream module: the adb executable and device-scoped adb calls.
export const adbExecutable = (): string => adb()
export const adbOnDevice = (args: string[], timeout?: number): Promise<Buffer> => sh(args, timeout)

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
    // الكاش ما بينتبه إذا انسكّر المحاكي: نتأكد كل مرة إنو الجهاز المخزّن لسا online، وإلا منصفّر الكاش ومنعيد الاكتشاف.
    if (serialCache) {
      const list = (await run(['devices'])).toString('utf8')
      const alive = list.split(/\r?\n/).slice(1).some((l) => { const p = l.trim().split(/\s+/); return p[0] === serialCache && p[1] === 'device' })
      if (!alive) resetDeviceCache()
    }
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

// Raw RGBA frame from the device (no PNG encode on the emulator, so it is faster).
// Header is width, height, format and a colour-space word; pixels follow as RGBA_8888.
// Returns BGRA pixels, the byte order Electron's nativeImage.createFromBitmap expects on Windows.
export async function screenshotBgra(): Promise<{ width: number; height: number; bgra: Buffer }> {
  const buf = await sh(['exec-out', 'screencap'])
  if (buf.length < 16) throw new Error('screenshot did not return frame data')
  const width = buf.readUInt32LE(0)
  const height = buf.readUInt32LE(4)
  const offset = buf.length - width * height * 4
  if (width <= 0 || height <= 0 || offset < 12)
    throw new Error('screenshot frame has an unexpected size')
  const bgra = Buffer.from(buf.subarray(offset))
  for (let i = 0; i < bgra.length; i += 4) {
    const r = bgra[i]
    bgra[i] = bgra[i + 2]
    bgra[i + 2] = r
  }
  return { width, height, bgra }
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

// The side panel sends many taps and swipes. A new adb process per input is slow,
// so the panel uses one long-lived `adb shell` that gets its commands on stdin.
let inputShell: ChildProcess | null = null
let inputShellSerial = ''
async function sendInputCommand(cmd: string): Promise<void> {
  const serial = await resolveSerial()
  if (
    !inputShell ||
    inputShellSerial !== serial ||
    !inputShell.stdin ||
    inputShell.stdin.destroyed
  ) {
    inputShell?.kill()
    const proc = spawn(adb(), ['-s', serial, 'shell'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true
    })
    proc.on('exit', () => {
      if (inputShell === proc) inputShell = null
    })
    proc.on('error', () => {
      if (inputShell === proc) inputShell = null
    })
    proc.stdin?.on('error', () => {
      if (inputShell === proc) inputShell = null
    })
    inputShell = proc
    inputShellSerial = serial
  }
  inputShell.stdin?.write(cmd + '\n')
}

function assertOnScreen(x: number, y: number, w: number, h: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h)
    throw new Error(`coordinates out of range (screen is ${w}x${h})`)
}

// Tap from the side panel: same checks as tap(), but through the long-lived shell.
export async function quickTap(x: number, y: number): Promise<void> {
  const { w, h } = await screenSize()
  assertOnScreen(x, y, w, h)
  await sendInputCommand(`input tap ${x} ${y}`)
}

// Swipe (or long press when both points are equal). ms is the gesture duration.
export async function swipe(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  ms: number
): Promise<void> {
  const { w, h } = await screenSize()
  assertOnScreen(x1, y1, w, h)
  assertOnScreen(x2, y2, w, h)
  const d = Number.isFinite(ms) ? Math.min(2000, Math.max(80, Math.round(ms))) : 300
  await sendInputCommand(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`)
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
