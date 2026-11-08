import { ipcMain } from 'electron'
import * as adb from '../tools/android-controller'
import { emulatorStartError, startAndroidEmulator } from './android-emulator'

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
  ipcMain.handle('android:screenshot', () => wrap(() => adb.screenshotDataUrl()))
  ipcMain.handle('android:tap', (_e, x: unknown, y: unknown) => wrap(() => adb.tap(Number(x), Number(y))))
  ipcMain.handle('android:key', (_e, k: unknown) => wrap(() => adb.pressKey(String(k) as adb.KeyName)))
  ipcMain.handle('android:text', (_e, t: unknown) => wrap(() => adb.typeText(String(t ?? ''))))
}
