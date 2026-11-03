import crypto from 'crypto'
import http from 'http'
import os from 'os'
import path from 'path'
import fsp from 'fs/promises'
import { shell } from 'electron'
import { getSecret, setSecret } from '../store/secure-store'
import { prepareFile } from './attach'

// دخول Drive بصلاحية قراءة بس (OAuth ديسكتوب مع PKCE وعنوان رجوع محلي). بيانات العميل والتوكن بالمخزن المشفّر.
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const CLIENT_KEY = 'GOOGLE_OAUTH_CLIENT'
const REFRESH_KEY = 'GOOGLE_DRIVE_REFRESH'
const MAX_DOWNLOAD = 25 * 1024 * 1024

interface Client { id: string; secret: string }
export interface DriveFile { id: string; name: string; mime: string; modified: string }

let access: { token: string; exp: number } | null = null

function client(): Client | null {
  try {
    const j = JSON.parse(getSecret(CLIENT_KEY)) as Client
    return j.id && j.secret ? j : null
  } catch { return null }
}

export function driveStatus(): { client: boolean; connected: boolean } {
  return { client: !!client(), connected: !!getSecret(REFRESH_KEY) }
}

/** بياخد ملف client_secret_*.json يلي نزّلتو من Google Cloud وبيخزّن المعرّف والسر بالمخزن المشفّر. */
export async function importClientFile(file: string): Promise<void> {
  const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { installed?: { client_id?: string; client_secret?: string } }
  const c = raw.installed
  if (!c?.client_id || !c.client_secret) throw new Error('الملف مو من نوع «Desktop app» أو ناقصو المعرّف أو السر')
  setSecret(CLIENT_KEY, JSON.stringify({ id: c.client_id, secret: c.client_secret }))
  setSecret(REFRESH_KEY, '')
  access = null
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20000),
  })
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error('Google رفض الطلب: ' + (j.error_description || j.error || r.status))
  return { access_token: j.access_token, expires_in: j.expires_in ?? 3000, refresh_token: j.refresh_token }
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** بيفتح المتصفح لتوافق إنت، وبيستنى الرد على عنوان محلي. */
export async function driveConnect(): Promise<void> {
  const c = client()
  if (!c) throw new Error('استورد ملف الاعتماد (client_secret.json) أول')
  const verifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))
  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return }
      const err = u.searchParams.get('error')
      const cd = u.searchParams.get('code')
      const ok = !err && !!cd && u.searchParams.get('state') === state
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;margin-top:20vh"><h2>' + (ok ? 'تمام، ارجع للبرنامج' : 'ما اكتمل الربط') + '</h2></body>')
      clearTimeout(timer)
      srv.close()
      const port = (srv.address() as { port?: number } | null)?.port
      if (ok && cd) resolve({ code: cd, redirect: 'http://127.0.0.1:' + String(port ?? lastPort) })
      else reject(new Error(err ? 'انرفض الربط: ' + err : 'رد غير صالح من Google'))
    })
    let lastPort = 0
    const timer = setTimeout(() => { srv.close(); reject(new Error('انتهى وقت الانتظار (3 دقايق) بدون موافقة')) }, 180000)
    srv.listen(0, '127.0.0.1', () => {
      lastPort = (srv.address() as { port: number }).port
      const redirect = 'http://127.0.0.1:' + lastPort
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: c.id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state,
        code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
      }).toString()
      void shell.openExternal(url)
    })
  })
  const t = await tokenRequest({ code: code.code, client_id: c.id, client_secret: c.secret, code_verifier: verifier, redirect_uri: code.redirect, grant_type: 'authorization_code' })
  if (!t.refresh_token) throw new Error('Google ما رجّع توكن دائم، جرّب مرة تانية')
  setSecret(REFRESH_KEY, t.refresh_token)
  access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }
}

export function driveDisconnect(): void { setSecret(REFRESH_KEY, ''); access = null }

async function token(): Promise<string> {
  if (access && access.exp > Date.now()) return access.token
  const c = client(); const rt = getSecret(REFRESH_KEY)
  if (!c || !rt) throw new Error('Drive مو مربوط')
  try {
    const t = await tokenRequest({ client_id: c.id, client_secret: c.secret, refresh_token: rt, grant_type: 'refresh_token' })
    access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }
    return access.token
  } catch (e) {
    if (/invalid_grant/.test((e as Error).message)) { setSecret(REFRESH_KEY, ''); throw new Error('انتهت صلاحية الربط (تطبيق الاختبار بينتهي كل 7 أيام). اربط Drive من جديد') }
    throw e
  }
}

async function api(url: string): Promise<Response> {
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + (await token()) }, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error('Drive رد بخطأ ' + r.status + ' ' + (await r.text()).slice(0, 140))
  return r
}

export async function driveSearch(query: string): Promise<DriveFile[]> {
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  let q = "trashed=false and mimeType!='application/vnd.google-apps.folder'"
  if (query.trim()) q += " and fullText contains '" + esc(query.trim().slice(0, 100)) + "'"
  const u = 'https://www.googleapis.com/drive/v3/files?' + new URLSearchParams({
    q, pageSize: '20', orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime)',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  }).toString()
  const j = (await (await api(u)).json()) as { files?: { id: string; name: string; mimeType: string; modifiedTime: string }[] }
  return (j.files ?? []).map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, modified: f.modifiedTime }))
}

/** بيرجّع نص الملف: مستندات Google بتتصدّر كنص، الجداول CSV، والباقي بينزل مؤقتاً ويتقرا مثل أي ملف مرفوع. */
export async function driveFetch(id: string, name: string, mime: string): Promise<{ name: string; text: string }> {
  const enc = encodeURIComponent(id)
  if (mime === 'application/vnd.google-apps.document' || mime === 'application/vnd.google-apps.presentation') {
    return { name, text: await (await api('https://www.googleapis.com/drive/v3/files/' + enc + '/export?mimeType=text%2Fplain')).text() }
  }
  if (mime === 'application/vnd.google-apps.spreadsheet') {
    return { name, text: await (await api('https://www.googleapis.com/drive/v3/files/' + enc + '/export?mimeType=text%2Fcsv')).text() }
  }
  if (mime.startsWith('application/vnd.google-apps.')) throw new Error('نوع ملف Google هاد ما بينقرا (' + mime.replace('application/vnd.google-apps.', '') + ')')
  const r = await api('https://www.googleapis.com/drive/v3/files/' + enc + '?alt=media&supportsAllDrives=true')
  const buf = Buffer.from(await r.arrayBuffer())
  if (buf.length > MAX_DOWNLOAD) throw new Error('الملف أكبر من 25MB')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'trl-drive-'))
  const file = path.join(dir, name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file')
  try {
    await fsp.writeFile(file, buf)
    const a = await prepareFile(file)
    if (!a.text?.trim()) throw new Error('ما قدرت أستخرج نص من الملف' + (a.note ? ' (' + a.note + ')' : ''))
    return { name, text: a.text }
  } finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined) }
}
