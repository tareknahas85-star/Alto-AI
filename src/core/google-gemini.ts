import crypto from 'crypto'
import http from 'http'
import fsp from 'fs/promises'
import { shell } from 'electron'
import { getSecret, setSecret } from '../store/secure-store'

// 5.21.27: دخول بحساب غوغل لـ Gemini API (OAuth ديسكتوب + PKCE + عنوان رجوع محلي). العميل (client_id/secret) من مشروع المستخدم نفسو،
// والتوكن الدائم بالمخزن المشفّر. المفتاح (API key) ما بينلمس: هاد طريق تاني بجنبو.
const CLIENT_KEY = 'GEMINI_OAUTH_CLIENT'
const REFRESH_KEY = 'GEMINI_OAUTH_REFRESH'
const SCOPE_NARROW = 'https://www.googleapis.com/auth/generative-language.retriever'
const SCOPE_WIDE = SCOPE_NARROW + ' https://www.googleapis.com/auth/cloud-platform'
const SCOPE_KEY = 'GEMINI_OAUTH_SCOPE'

interface Client { id: string; secret: string }
let access: { token: string; exp: number } | null = null

function client(): Client | null {
  try {
    const j = JSON.parse(getSecret(CLIENT_KEY)) as Client
    return j.id && j.secret ? j : null
  } catch {
    return null
  }
}

/** رقم المشروع من أول معرّف العميل (30987619371-xxxx.apps.googleusercontent.com): بيروح بترويسة x-goog-user-project. */
export function googleProject(): string {
  const c = client()
  const m = c ? /^(\d{6,})-/.exec(c.id) : null
  return m ? m[1] : ''
}

export function googleStatus(): { client: boolean; connected: boolean; project: string; wide: boolean } {
  return { client: !!client(), connected: !!getSecret(REFRESH_KEY), project: googleProject(), wide: getSecret(SCOPE_KEY) === 'wide' }
}

export function googleLoggedIn(): boolean {
  return !!client() && !!getSecret(REFRESH_KEY)
}

export function googleSaveClient(id: string, secret: string): void {
  const i = id.trim()
  const s = secret.trim()
  if (!i && !s) {
    setSecret(CLIENT_KEY, '')
    setSecret(REFRESH_KEY, '')
    access = null
    return
  }
  if (!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(i)) throw new Error('الـ Client ID شكلو مو صحيح (لازم ينتهي بـ apps.googleusercontent.com)')
  if (s.length < 10) throw new Error('الـ Client Secret قصير أو فاضي')
  setSecret(CLIENT_KEY, JSON.stringify({ id: i, secret: s }))
  setSecret(REFRESH_KEY, '')
  access = null
}

/** بياخد ملف client_secret_*.json يلي نزّلتو من Google Cloud (نوع Desktop app). */
export async function googleImportClientFile(file: string): Promise<void> {
  const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { installed?: { client_id?: string; client_secret?: string } }
  const c = raw.installed
  if (!c?.client_id || !c.client_secret) throw new Error('الملف مو من نوع «Desktop app» أو ناقصو المعرّف أو السر')
  googleSaveClient(c.client_id, c.client_secret)
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20000)
  })
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string }
  if (!r.ok || !j.access_token) throw new Error('Google رفض الطلب: ' + (j.error_description || j.error || r.status))
  return { access_token: j.access_token, expires_in: j.expires_in ?? 3000, refresh_token: j.refresh_token }
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** بيفتح المتصفح لتوافق إنت، وبيستنى الرد على عنوان محلي. wide=true بيزيد صلاحية cloud-platform (بس إذا الضيّقة ما كفت). */
export async function googleLogin(wide = false): Promise<void> {
  const c = client()
  if (!c) throw new Error('حط الـ Client ID والـ Client Secret أول')
  const verifier = b64url(crypto.randomBytes(48))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = b64url(crypto.randomBytes(16))
  let lastPort = 0
  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (u.pathname !== '/') {
        res.writeHead(404)
        res.end()
        return
      }
      const err = u.searchParams.get('error')
      const cd = u.searchParams.get('code')
      const ok = !err && !!cd && u.searchParams.get('state') === state
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;margin-top:20vh"><h2>' + (ok ? 'تمام، ارجع للبرنامج' : 'ما اكتمل الدخول') + '</h2></body>')
      clearTimeout(timer)
      srv.close()
      if (ok && cd) resolve({ code: cd, redirect: 'http://127.0.0.1:' + String(lastPort) })
      else reject(new Error(err ? 'انرفض الدخول: ' + err : 'رد غير صالح من Google'))
    })
    const timer = setTimeout(() => {
      srv.close()
      reject(new Error('انتهى وقت الانتظار (3 دقايق) بدون موافقة'))
    }, 180000)
    srv.listen(0, '127.0.0.1', () => {
      lastPort = (srv.address() as { port: number }).port
      const url =
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        new URLSearchParams({
          client_id: c.id,
          redirect_uri: 'http://127.0.0.1:' + lastPort,
          response_type: 'code',
          scope: wide ? SCOPE_WIDE : SCOPE_NARROW,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent'
        }).toString()
      void shell.openExternal(url)
    })
  })
  const t = await tokenRequest({ code: code.code, client_id: c.id, client_secret: c.secret, code_verifier: verifier, redirect_uri: code.redirect, grant_type: 'authorization_code' })
  if (!t.refresh_token) throw new Error('Google ما رجّع توكن دائم، جرّب مرة تانية')
  setSecret(REFRESH_KEY, t.refresh_token)
  setSecret(SCOPE_KEY, wide ? 'wide' : 'narrow')
  access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }
}

export function googleLogout(): void {
  setSecret(REFRESH_KEY, '')
  access = null
}

/** توكن صالح (بيتجدد لحالو). */
export async function googleAccessToken(): Promise<string> {
  if (access && access.exp > Date.now()) return access.token
  const c = client()
  const rt = getSecret(REFRESH_KEY)
  if (!c || !rt) throw new Error('حساب غوغل مو مربوط (Gemini)')
  try {
    const t = await tokenRequest({ client_id: c.id, client_secret: c.secret, refresh_token: rt, grant_type: 'refresh_token' })
    access = { token: t.access_token, exp: Date.now() + (t.expires_in - 60) * 1000 }
    return access.token
  } catch (e) {
    if (/invalid_grant/.test((e as Error).message)) {
      setSecret(REFRESH_KEY, '')
      throw new Error('انتهت صلاحية الدخول بحساب غوغل. سجّل دخول من جديد')
    }
    throw e
  }
}

/** ترويسات الاتصال بـ Gemini API بتوكن الحساب. */
export function googleHeaders(): Record<string, string> {
  const p = googleProject()
  return p ? { 'x-goog-user-project': p } : {}
}