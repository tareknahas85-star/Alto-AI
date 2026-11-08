import { ipcMain, nativeImage } from 'electron'
import * as adb from '../tools/android-controller'
import { emulatorStartError, startAndroidEmulator } from './android-emulator'
import { scroll, startStream, stopStream, touch } from './android-stream'

// Lets the user drive the emulator from the side panel.
// These calls come from the user's own clicks, so they skip the agent approval step.
// Every input is still validated by android-controller.

type Res<T = unknown> = { ok: boolean; data?: T; error?: string }
const wrap = async <T>(fn: () => Promise<T>): Promise<Res<T>> => {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function registerAndroidHandlers(): void {
  ipcMain.handle('android:status', () => wrap(() => adb.status()))
  ipcMain.handle('android:start', async (): Promise<Res<boolean>> => {
    const ok = await startAndroidEmulator()
    return ok ? { ok: true, data: true } : { ok: false, error: emulatorStartError() || 'تعذّر تشغيل المحاكي' }
  })

  // The panel gets a smaller JPEG: it moves and decodes faster, and taps map by ratio, so nothing shifts.
  ipcMain.handle('android:screenshot', () =>
    wrap(async () => {
      const frame = await adb.screenshotBgra()
      const img = nativeImage.createFromBitmap(frame.bgra, {
        width: frame.width,
        height: frame.height
      })
      const small = img.getSize().width > 540 ? img.resize({ width: 540 }) : img
      return 'data:image/jpeg;base64,' + small.toJPEG(80).toString('base64')
    })
  )
  // Live stream: the video comes back on the 'android:video' channel, touch goes out fire-and-forget.
  ipcMain.handle('android:stream-start', async (e) => {
    const err = await startStream(e.sender)
    return err ? { ok: false, error: err } : { ok: true, data: true }
  })
  ipcMain.handle('android:stream-stop', () => {
    stopStream()
    return { ok: true }
  })
  ipcMain.on('android:touch', (_e, action: unknown, x: unknown, y: unknown) => {
    const a = Number(action)
    if (a === 0 || a === 1 || a === 2) touch(a, Number(x), Number(y))
  })
  ipcMain.on('android:scroll', (_e, x: unknown, y: unknown, dy: unknown) => {
    scroll(Number(x), Number(y), Number(dy))
  })
  ipcMain.handle('android:tap', (_e, x: unknown, y: unknown) => wrap(() => adb.quickTap(Number(x), Number(y))))
  ipcMain.handle('android:swipe', (_e, x1: unknown, y1: unknown, x2: unknown, y2: unknown, ms: unknown) =>
    wrap(() => adb.swipe(Number(x1), Number(y1), Number(x2), Number(y2), Number(ms)))
  )
  ipcMain.handle('android:key', (_e, k: unknown) => wrap(() => adb.pressKey(String(k) as adb.KeyName)))
  ipcMain.handle('android:text', (_e, t: unknown) => wrap(() => adb.typeText(String(t ?? ''))))
}
