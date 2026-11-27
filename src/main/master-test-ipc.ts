import { app, ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { runMasterTests } from '../core/master-test'
import { getPrefs } from '../core/prefs'
import { cancelScan, clearScan, scanStatus, startScan } from '../core/master-scan'

export function registerMasterTestHandlers(): void {
  ipcMain.handle('masterScan:start', () => startScan())
  ipcMain.handle('masterScan:cancel', () => cancelScan())
  ipcMain.handle('masterScan:status', () => scanStatus())
  ipcMain.handle('masterScan:clear', () => clearScan())
  ipcMain.handle('masterTest:run', async () => {
    try {
      // The master picked in Settings is tested first (so the test follows the choice), with gemini-4-hydrogen as the baseline.
      const chosen = getPrefs().masterModel
      const hints = chosen ? [chosen, 'gemini-4-hydrogen'] : ['gemini-4-hydrogen']
      const models = await runMasterTests(hints.filter((h, i) => hints.indexOf(h) === i))
      const dir = path.join(app.getPath('userData'), 'master-tests')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, 'master-test-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json')
      fs.writeFileSync(file, JSON.stringify({ models }, null, 2), 'utf8')
      const summary = models.map((m) => m.model + ': ' + JSON.stringify(m.summary)).join('\n')
      return { ok: true, file, summary }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}