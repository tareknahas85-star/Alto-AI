import { BrowserWindow, dialog, ipcMain } from 'electron'
import fsp from 'fs/promises'
import ExcelJS from 'exceljs'
import { newId, readJson, writeJson } from '../core/json-store'
import { checkSideUrl } from '../core/side-url'
import {
  MAX_SOURCE_CHARS, OUTPUT_KINDS, buildAskPrompt, buildOutputPrompt, csvOf, htmlToText, isPrivateHost, outputTitle, parseCsv, retrieve,
  type Notebook, type NbSource, type OutputKind
} from '../core/notebook'
import { prepareFile } from './attach'

// «دفتر»: notebooks live in one JSON file. The chat pipeline answers; this file only prepares prompts and stores results.
const FILE = 'notebooks.json'
type Runner = (prompt: string) => Promise<{ content: string; failed?: boolean }>
let runner: Runner | null = null
export const setNotebookRunner = (r: Runner): void => { runner = r }

const all = (): Notebook[] => readJson<Notebook[]>(FILE, [])
const save = (l: Notebook[]): void => writeJson(FILE, l)
const find = (l: Notebook[], id: unknown): Notebook | undefined => (typeof id === 'string' ? l.find((n) => n.id === id) : undefined)

const view = (n: Notebook): unknown => ({
  id: n.id, title: n.title, at: n.at, notes: n.notes,
  sources: n.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, chars: s.text.length, ref: s.ref }))
})

async function fetchPage(rawUrl: string): Promise<{ name: string; text: string }> {
  const c = checkSideUrl(rawUrl)
  if (!c.ok) throw new Error(c.reason)
  const u = new URL(c.url)
  if (isPrivateHost(u.hostname)) throw new Error('ما بقدر أقرأ عناوين الجهاز أو الشبكة المحلية')
  const r = await fetch(c.url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (Notebook reader)' } })
  if (!r.ok) throw new Error('الموقع رد بخطأ ' + r.status)
  if (isPrivateHost(new URL(r.url).hostname)) throw new Error('التحويل راح لعنوان محلي، انرفض')
  const type = r.headers.get('content-type') ?? ''
  if (!/text|html|json|xml/i.test(type)) throw new Error('نوع الصفحة مو نصي (' + type + ')')
  const html = (await r.text()).slice(0, 2_000_000)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim()
  return { name: title || u.hostname, text: htmlToText(html) }
}

async function run(prompt: string): Promise<string> {
  if (!runner) throw new Error('المحرّك مو جاهز')
  const r = await runner(prompt)
  if (r.failed || !r.content.trim()) throw new Error(r.content?.trim() || 'ما وصلني رد من الموديل')
  // the chat pipeline appends a review footer to its answers; it isn't part of the notebook output
  return r.content.replace(/\r?\n+(?:[-—_]{3,}\s*\r?\n)?\s*[^\n]*مراجعة مستقلة[\s\S]*$/, '').trim()
}

export function registerNotebookIpc(): void {
  ipcMain.handle('nb:list', () => all().map((n) => ({ id: n.id, title: n.title, at: n.at, sources: n.sources.length, notes: n.notes.length })))
  ipcMain.handle('nb:get', (_e, id: unknown) => { const n = find(all(), id); return n ? view(n) : null })
  ipcMain.handle('nb:create', (_e, title: unknown) => {
    const l = all()
    const n: Notebook = { id: newId(), title: (typeof title === 'string' && title.trim() ? title.trim() : 'دفتر جديد').slice(0, 80), at: Date.now(), sources: [], notes: [] }
    l.unshift(n)
    save(l)
    return view(n)
  })
  ipcMain.handle('nb:rename', (_e, id: unknown, title: unknown) => {
    const l = all(); const n = find(l, id)
    if (!n || typeof title !== 'string' || !title.trim()) return false
    n.title = title.trim().slice(0, 80); save(l); return true
  })
  ipcMain.handle('nb:delete', (_e, id: unknown) => { save(all().filter((n) => n.id !== id)); return true })

  const addSource = (id: unknown, s: Omit<NbSource, 'id' | 'at'>): unknown => {
    const l = all(); const n = find(l, id)
    if (!n) throw new Error('الدفتر مو موجود')
    const text = s.text.slice(0, MAX_SOURCE_CHARS)
    if (!text.trim()) throw new Error('المصدر فاضي أو ما قدرت أقرأ نصه')
    n.sources.push({ ...s, text, id: newId(), at: Date.now() })
    save(l)
    return view(n)
  }

  ipcMain.handle('nb:addText', (_e, id: unknown, name: unknown, text: unknown) => {
    if (typeof text !== 'string') return { ok: false, error: 'نص مو صالح' }
    try { return { ok: true, nb: addSource(id, { name: (typeof name === 'string' && name.trim()) || 'نص ملصوق', kind: 'text', text }) } } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle('nb:addLink', async (_e, id: unknown, url: unknown) => {
    if (typeof url !== 'string') return { ok: false, error: 'رابط مو صالح' }
    try {
      const p = await fetchPage(url)
      return { ok: true, nb: addSource(id, { name: p.name.slice(0, 120), kind: 'link', text: p.text, ref: url }) }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle('nb:addFiles', async (event, id: unknown, paths?: unknown) => {
    let files: string[] = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    if (files.length === 0) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const r = await (win ? dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }) : dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] }))
      if (r.canceled) return { ok: true, nb: view(find(all(), id) ?? { id: '', title: '', at: 0, sources: [], notes: [] }), added: 0, skipped: [] as string[] }
      files = r.filePaths
    }
    const skipped: string[] = []
    let added = 0
    for (const f of files.slice(0, 20)) {
      try {
        const a = await prepareFile(f)
        if (!a.text || !a.text.trim()) { skipped.push(a.name + (a.note ? ' (' + a.note + ')' : ' (ما قدرت أستخرج نص)')); continue }
        addSource(id, { name: a.name, kind: 'file', text: a.text, ref: f })
        added++
      } catch (e) { skipped.push(f.split(/[\\/]/).pop() + ' (' + (e as Error).message + ')') }
    }
    const n = find(all(), id)
    return { ok: !!n, nb: n ? view(n) : null, added, skipped }
  })
  ipcMain.handle('nb:removeSource', (_e, id: unknown, sid: unknown) => {
    const l = all(); const n = find(l, id)
    if (!n) return null
    n.sources = n.sources.filter((s) => s.id !== sid); save(l); return view(n)
  })

  const addNote = (id: string, note: Omit<Notebook['notes'][number], 'id' | 'at'>): unknown => {
    const l = all(); const n = find(l, id)
    if (!n) throw new Error('الدفتر مو موجود')
    n.notes.unshift({ ...note, id: newId(), at: Date.now() })
    save(l)
    return view(n)
  }

  ipcMain.handle('nb:ask', async (_e, id: unknown, question: unknown) => {
    const n = find(all(), id)
    if (!n || typeof question !== 'string' || !question.trim()) return { ok: false, error: 'سؤال أو دفتر مو صالح' }
    if (n.sources.length === 0) return { ok: false, error: 'ضيف مصدر واحد على الأقل قبل ما تسأل' }
    try {
      const chunks = retrieve(n.sources, question)
      const body = await run(buildAskPrompt(question.trim(), chunks))
      return { ok: true, nb: addNote(n.id, { kind: 'answer', title: question.trim().slice(0, 140), body }) }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle('nb:generate', async (_e, id: unknown, kind: unknown, focus: unknown) => {
    const n = find(all(), id)
    if (!n || typeof kind !== 'string' || !OUTPUT_KINDS.includes(kind as OutputKind)) return { ok: false, error: 'طلب مو صالح' }
    if (n.sources.length === 0) return { ok: false, error: 'ضيف مصدر واحد على الأقل أول' }
    const k = kind as OutputKind
    try {
      const body = await run(buildOutputPrompt(k, n.sources, typeof focus === 'string' ? focus : ''))
      return { ok: true, nb: addNote(n.id, { kind: k, title: outputTitle(k), body }) }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  ipcMain.handle('nb:deleteNote', (_e, id: unknown, noteId: unknown) => {
    const l = all(); const n = find(l, id)
    if (!n) return null
    n.notes = n.notes.filter((x) => x.id !== noteId); save(l); return view(n)
  })

  /** Saves a note to disk: tables become .xlsx (or .csv), everything else .md. */
  ipcMain.handle('nb:export', async (event, id: unknown, noteId: unknown) => {
    const n = find(all(), id)
    const note = n?.notes.find((x) => x.id === noteId)
    if (!n || !note) return { ok: false, error: 'الملاحظة مو موجودة' }
    const win = BrowserWindow.fromWebContents(event.sender)
    const isTable = note.kind === 'table' && !!csvOf(note.body)
    const base = (note.title || 'دفتر').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    const opts = isTable
      ? { defaultPath: base + '.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }] }
      : { defaultPath: base + '.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }
    const r = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (r.canceled || !r.filePath) return { ok: false, error: 'انلغى' }
    try {
      if (isTable) {
        const rows = parseCsv(csvOf(note.body) as string)
        if (/\.csv$/i.test(r.filePath)) await fsp.writeFile(r.filePath, '﻿' + rows.map((x) => x.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n'), 'utf8')
        else {
          const wb = new ExcelJS.Workbook()
          const ws = wb.addWorksheet('دفتر', { views: [{ rightToLeft: true }] })
          rows.forEach((x) => ws.addRow(x))
          ws.getRow(1).font = { bold: true }
          ws.columns.forEach((c) => { c.width = 24 })
          await wb.xlsx.writeFile(r.filePath)
        }
      } else await fsp.writeFile(r.filePath, '# ' + note.title + '\n\n' + note.body + '\n', 'utf8')
      return { ok: true, path: r.filePath }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  })
}
