import type OpenAI from 'openai'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { approveWrite } from '../core/accounts'
import * as adb from './android-controller'
import { buildDebugApk } from './android-build'

// Android emulator tools for the agent.
// Read-only tools (screenshot, read UI) run freely. Anything that changes the device or runs code
// (tap, type, key, build, install, launch) needs the user's approval, every single time.
// The screenshot is also handed to the model as an image: the chat loop calls takePendingImage()
// after each tool round and attaches it as a user message.

export const needsAndroid = (t: string): boolean =>
  /android|أندرويد|اندرويد|emulator|محاكي|apk|موبايل.*(اختبر|جرب)|اختبر.*(موبايل|تطبيق)/i.test(t)

type Handlers = Map<string, (a: Record<string, unknown>) => Promise<string>>

let actionCounter = 0
let pendingImage: string | null = null
let lastApk: string | null = null

// Returns the screenshot queued by the last android_screenshot call, once.
export function takePendingImage(): string | null {
  const img = pendingImage
  pendingImage = null
  return img
}

const errText = (e: unknown): string => `Error: ${e instanceof Error ? e.message : String(e)}`

// Compact summary of the UI tree: only elements a person or agent can read or press.
const decodeXml = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export function summarizeUi(xml: string, limit = 120): string {
  const rows: string[] = []
  const nodeRe = /<node\b([^>]*?)\/?>/g
  let m: RegExpExecArray | null
  while ((m = nodeRe.exec(xml)) && rows.length < limit) {
    const attrs = m[1]
    const get = (k: string): string => attrs.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? ''
    const text = get('text')
    const desc = get('content-desc')
    const clickable = get('clickable') === 'true'
    const b = get('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    if (!b || (!text && !desc && !clickable)) continue
    const cx = Math.round((Number(b[1]) + Number(b[3])) / 2)
    const cy = Math.round((Number(b[2]) + Number(b[4])) / 2)
    const label =
      decodeXml(text || desc)
        .replace(/\s+/g, ' ')
        .slice(0, 80) || '(no label)'
    rows.push(`(${cx},${cy}) ${label}${clickable ? ' [tap]' : ''}`)
  }
  return rows.length ? rows.join('\n') : '(no readable elements on screen)'
}

export function addAndroidTools(defs: OpenAI.Chat.ChatCompletionTool[], handlers: Handlers): void {
  const fn = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = []
  ): number =>
    defs.push({
      type: 'function',
      function: { name, description, parameters: { type: 'object', properties, required } }
    })

  fn(
    'android_screenshot',
    'Take a screenshot of the connected Android emulator or phone. The image is attached so you can see the screen. Read-only.',
    {}
  )
  fn(
    'android_read_ui',
    'Read the current Android screen as a list of on-screen elements: each line is (centre x,y) label, with [tap] when the element can be pressed. Read-only. Use these coordinates for android_tap.',
    {}
  )
  fn(
    'android_tap',
    'Tap one point on the Android screen, in device pixels (use coordinates from android_read_ui). The user must approve.',
    {
      x: { type: 'number' },
      y: { type: 'number' }
    },
    ['x', 'y']
  )
  fn(
    'android_input_text',
    'Type text into the focused field on Android. Only letters, digits, spaces and . , @ _ - are allowed, max 200 chars. The user must approve.',
    {
      text: { type: 'string' }
    },
    ['text']
  )
  fn(
    'android_press_key',
    'Press a system key on Android: BACK, HOME or RECENTS. The user must approve.',
    {
      key: { type: 'string', enum: ['BACK', 'HOME', 'RECENTS'] }
    },
    ['key']
  )
  fn(
    'android_build',
    'Build a debug APK of an Android project folder that has a Gradle wrapper (gradlew). The user must approve, because it runs the project build. Returns the APK path.',
    {
      project_path: { type: 'string', description: 'absolute path of the Android project folder' }
    },
    ['project_path']
  )
  fn(
    'android_install',
    'Install an APK on the connected emulator or phone. If apk_path is omitted, uses the last APK built. The user must approve.',
    {
      apk_path: { type: 'string' }
    }
  )
  fn(
    'android_launch',
    'Open an installed app by its package name (example: com.example.app). The user must approve.',
    {
      package: { type: 'string' }
    },
    ['package']
  )
  fn(
    'android_device_info',
    'Read-only: model, Android version, screen size and connection state of the connected emulator or phone.',
    {},
    []
  )
  fn(
    'android_logcat',
    'Read-only: the last log lines from the device (Android logcat). Optional: package (only that app), level (V/D/I/W/E, default W), lines (default 200, max 500).',
    {
      package: { type: 'string' },
      level: { type: 'string' },
      lines: { type: 'number' }
    },
    []
  )
  fn(
    'android_stop_app',
    'Force-stop an app by its package name (example: com.example.app). The user must approve.',
    {
      package: { type: 'string' }
    },
    ['package']
  )

  const gate = (tool: string, args: Record<string, unknown>): Promise<boolean> =>
    approveWrite('android#' + ++actionCounter, tool, args)

  handlers.set('android_screenshot', async () => {
    try {
      const png = await adb.screenshotPng()
      const dir = join(tmpdir(), 'alto-android')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `screen-${Date.now()}.png`)
      writeFileSync(file, png)
      pendingImage = 'data:image/png;base64,' + png.toString('base64')
      const { w, h } = await adb.screenSize()
      return `Screenshot taken (${w}x${h}); it is attached below as an image. Saved at ${file}.`
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_read_ui', async () => {
    try {
      return summarizeUi(await adb.uiTreeXml())
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_tap', async (a) => {
    const x = Number(a.x)
    const y = Number(a.y)
    if (!(await gate('android_tap', { x, y })))
      return 'The user declined this tap. Do not retry it.'
    try {
      await adb.tap(x, y)
      return `Tapped (${x},${y}). Read the screen again to confirm the result.`
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_input_text', async (a) => {
    const text = String(a.text ?? '')
    if (!(await gate('android_input_text', { text })))
      return 'The user declined this typing. Do not retry it.'
    try {
      await adb.typeText(text)
      return 'Text typed into the focused field.'
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_press_key', async (a) => {
    const key = String(a.key ?? '') as adb.KeyName
    if (!(await gate('android_press_key', { key })))
      return 'The user declined this key press. Do not retry it.'
    try {
      await adb.pressKey(key)
      return `Pressed ${key}.`
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_build', async (a) => {
    const projectPath = String(a.project_path ?? '')
    if (!(await gate('android_build', { projectPath })))
      return 'The user declined this build. Do not retry it.'
    try {
      const { apk, log } = await buildDebugApk(projectPath)
      lastApk = apk
      return `Build OK. APK: ${apk}\nLast log lines:\n${log}`
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_install', async (a) => {
    const apk = String(a.apk_path ?? lastApk ?? '')
    if (!apk) return 'Error: no APK. Build one first or pass apk_path.'
    if (!(await gate('android_install', { apk })))
      return 'The user declined this install. Do not retry it.'
    try {
      await adb.installApk(apk)
      return `Installed ${apk}.`
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_launch', async (a) => {
    const pkg = String(a.package ?? '')
    if (!(await gate('android_launch', { pkg })))
      return 'The user declined this launch. Do not retry it.'
    try {
      await adb.launchPackage(pkg)
      return `Launched ${pkg}. Read the screen to check it opened.`
    } catch (e) {
      return errText(e)
    }
  })

  const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

  handlers.set('android_device_info', async () => {
    try {
      const st = await adb.status()
      if (!st.connected) return 'No device connected: ' + (st.error ?? '')
      const prop = async (k: string): Promise<string> => (await adb.adbOnDevice(['shell', 'getprop', k], 10000)).toString().trim()
      const [model, release, sdk] = await Promise.all([prop('ro.product.model'), prop('ro.build.version.release'), prop('ro.build.version.sdk')])
      return `Device ${st.serial}: ${model}, Android ${release} (API ${sdk}), screen ${st.size?.w}x${st.size?.h}.`
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_logcat', async (a) => {
    const pkg = String(a.package ?? '').trim()
    const lvl = String(a.level ?? 'W').trim().toUpperCase().slice(0, 1)
    const n = Math.min(500, Math.max(10, Number(a.lines) || 200))
    if (pkg && !PKG_RE.test(pkg)) return 'Error: invalid package name.'
    if (!'VDIWEF'.includes(lvl)) return 'Error: level must be V, D, I, W or E.'
    try {
      const raw = (await adb.adbOnDevice(['logcat', '-d', '-v', 'time', '*:' + lvl], 20000)).toString()
      let lines = raw.split(/\r?\n/).filter(Boolean)
      if (pkg) {
        const pid = (await adb.adbOnDevice(['shell', 'pidof', pkg], 10000)).toString().trim().split(/\s+/)[0]
        lines = lines.filter((l) => l.includes(pkg) || (pid !== '' && l.includes('(' + pid + ')') || (pid !== '' && new RegExp('\\b' + pid + '\\b').test(l))))
      }
      const tail = lines.slice(-n)
      return tail.length ? tail.join('\n').slice(-20000) : 'No log lines at this level' + (pkg ? ' for ' + pkg : '') + '.'
    } catch (e) {
      return errText(e)
    }
  })

  handlers.set('android_stop_app', async (a) => {
    const pkg = String(a.package ?? '').trim()
    if (!PKG_RE.test(pkg)) return 'Error: invalid package name.'
    if (!(await gate('android_stop_app', { pkg })))
      return 'The user declined this. Do not retry it.'
    try {
      await adb.adbOnDevice(['shell', 'am', 'force-stop', pkg], 15000)
      return `Stopped ${pkg}.`
    } catch (e) {
      return errText(e)
    }
  })
}
