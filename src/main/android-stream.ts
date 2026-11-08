import { app, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createConnection, type Socket } from 'net'
import { existsSync } from 'fs'
import { join } from 'path'
import * as adb from '../tools/android-controller'

// Live screen of the emulator, streamed the way scrcpy does it:
// a small server runs on the device and sends H.264 video over a forwarded socket,
// and touch events go back over a second socket. No window, no screenshots.
// The renderer decodes the video with WebCodecs and draws it inside the side panel.

const SERVER_VERSION = '2.7'
const DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar'
const LOCAL_PORT = 27183
const CONNECT_TRIES = 40

type Session = {
  serial: string
  size: { w: number; h: number }
  server: ChildProcess
  video: Socket
  control: Socket
  wc: WebContents
}

let session: Session | null = null
let pendingStart: Promise<string | null> | null = null

export function serverJarPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'scrcpy-server.jar')
    : join(app.getAppPath(), 'resources', 'scrcpy-server.jar')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function connectOnce(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection({ host: '127.0.0.1', port: LOCAL_PORT })
    s.once('connect', () => {
      s.on('error', () => undefined) // errors after connecting are handled by the close path
      resolve(s)
    })
    s.once('error', (e) => {
      s.destroy()
      reject(e)
    })
  })
}

// adb accepts the local connection before the server is listening on the device, and then
// closes it. So a socket only counts once it has stayed open for a moment.
async function connectStable(): Promise<Socket> {
  let lastErr: unknown = null
  for (let i = 0; i < CONNECT_TRIES; i++) {
    try {
      const s = await connectOnce()
      await sleep(300)
      if (!s.destroyed) return s
      lastErr = new Error('stream socket closed right after connecting')
    } catch (e) {
      lastErr = e
    }
    await sleep(150)
  }
  throw lastErr instanceof Error ? lastErr : new Error('could not reach the stream server')
}

// Starts the stream. Returns null on success or an error message.
export function startStream(wc: WebContents): Promise<string | null> {
  if (session && !session.wc.isDestroyed()) {
    session.wc = wc
    return Promise.resolve(null)
  }
  pendingStart ??= doStart(wc).finally(() => {
    pendingStart = null
  })
  return pendingStart
}

async function doStart(wc: WebContents): Promise<string | null> {
  const jar = serverJarPath()
  if (!existsSync(jar)) return 'ملف خادم البث (scrcpy-server.jar) مو موجود'
  let serial: string
  try {
    serial = await adb.resolveSerial()
    await adb.adbOnDevice(['push', jar, DEVICE_JAR], 60000)
    await adb.adbOnDevice(['forward', '--remove', `tcp:${LOCAL_PORT}`]).catch(() => undefined)
    await adb.adbOnDevice(['forward', `tcp:${LOCAL_PORT}`, 'localabstract:scrcpy'])
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }

  const server = spawn(
    adb.adbExecutable(),
    [
      '-s',
      serial,
      'shell',
      'CLASSPATH=' + DEVICE_JAR,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SERVER_VERSION,
      'tunnel_forward=true',
      'video=true',
      'audio=false',
      'control=true',
      'cleanup=true',
      'raw_stream=true',
      'max_size=0',
      'max_fps=30',
      'video_bit_rate=6000000',
      'send_frame_meta=false'
    ],
    // stdin stays open: with a closed stdin, adb shell ends the session and the server dies with it
    { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
  )

  let video: Socket
  let control: Socket
  try {
    video = await connectStable()
    control = await connectStable()
  } catch (e) {
    server.kill()
    return e instanceof Error ? e.message : String(e)
  }

  const size = await adb.screenSize()
  const s: Session = { serial, size, server, video, control, wc }
  session = s
  video.on('data', (chunk: Buffer) => {
    if (!s.wc.isDestroyed()) s.wc.send('android:video', chunk)
  })
  control.on('data', () => undefined) // the server sends clipboard data here; the panel does not use it
  const finish = (): void => {
    if (session === s) stopStream()
    if (!s.wc.isDestroyed()) s.wc.send('android:video-end')
  }
  video.on('close', finish)
  video.on('error', finish)
  control.on('close', finish)
  control.on('error', finish)
  server.on('exit', finish)
  return null
}

export function stopStream(): void {
  const s = session
  session = null
  if (!s) return
  s.video.destroy()
  s.control.destroy()
  s.server.kill()
  adb.adbOnDevice(['forward', '--remove', `tcp:${LOCAL_PORT}`]).catch(() => undefined)
}

// Control messages (scrcpy protocol). Positions are device pixels.
export function touch(action: 0 | 1 | 2, x: number, y: number): void {
  const s = session
  if (!s || s.control.destroyed) return
  const { w, h } = s.size
  const cx = Math.min(w - 1, Math.max(0, Math.round(x)))
  const cy = Math.min(h - 1, Math.max(0, Math.round(y)))
  const b = Buffer.alloc(32)
  b[0] = 2 // INJECT_TOUCH_EVENT
  b[1] = action // 0 down, 1 up, 2 move
  b.writeBigInt64BE(BigInt(0), 2) // pointer id
  b.writeUInt32BE(cx, 10)
  b.writeUInt32BE(cy, 14)
  b.writeUInt16BE(w, 18)
  b.writeUInt16BE(h, 20)
  b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22) // pressure
  b.writeUInt32BE(action === 1 ? 0 : 1, 24) // action button
  b.writeUInt32BE(action === 1 ? 0 : 1, 28) // buttons held
  s.control.write(b)
}

// Wheel: the device ignores injected scroll events in this setup, so a wheel notch becomes a short
// finger swipe. dy > 0 (wheel down) swipes the finger up, which moves the content up like a scroll.
let swipeBusy = false
export function scroll(x: number, y: number, dy: number): void {
  const s = session
  if (!s || s.control.destroyed || swipeBusy) return
  const { h } = s.size
  const steps = 6
  const dist = Math.min(360, Math.max(140, Math.abs(dy) * 1.2))
  const from = Math.min(h - 2, Math.max(1, Math.round(y)))
  const to = Math.min(h - 2, Math.max(1, Math.round(dy > 0 ? from - dist : from + dist)))
  const cx = Math.round(x)
  swipeBusy = true
  touch(0, cx, from)
  let i = 0
  const step = (): void => {
    i++
    if (i < steps) {
      touch(2, cx, Math.round(from + ((to - from) * i) / steps))
      setTimeout(step, 8)
      return
    }
    touch(2, cx, to)
    touch(1, cx, to)
    swipeBusy = false
  }
  setTimeout(step, 8)
}

export const isStreaming = (): boolean => session !== null
