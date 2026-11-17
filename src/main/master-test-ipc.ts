import { app, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { runMasterTest } from '../core/master-test'

export function registerMasterTestHandlers(): void {
  ipcMain.handle('masterTest:run', async () => {
    try {
      const res = await runMasterTest('gemini-4-carbon')
      const dir = path.join(app.getPath('userData'), 'master-tests')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'master-test-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
      fs.writeFileSync(file, JSON.stringify(res, null, 2), 'utf8')
      return { ok: true, file, summary: JSON.stringify(res.summary) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}