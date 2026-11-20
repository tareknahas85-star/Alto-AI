// Gemini over the native generateContent API with a Google-account OAuth token.
// The OpenAI-compatible endpoint rejects OAuth bearer tokens (400), so this module
// translates OpenAI chat.completions calls into native calls and back.
import { googleAccessToken, googleHeaders } from './google-gemini'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: 'Bearer ' + (await googleAccessToken()), ...googleHeaders(), 'content-type': 'application/json' }
}

export async function googleListModels(): Promise<string[]> {
  const out: string[] = []
  let page = ''
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}/models?pageSize=200${page ? '&pageToken=' + encodeURIComponent(page) : ''}`, { headers: await authHeaders(), signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 220))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = (await r.json()) as any
    for (const m of j.models ?? []) {
      const id = String(m.name ?? '').replace(/^models\//, '')
      const ok = (m.supportedGenerationMethods ?? []).includes('generateContent')
      if (ok && /^gemini/i.test(id) && !/embed|aqa|imagen|tts|veo|live|image|audio|robotics|computer-use/i.test(id)) out.push(id)
    }
    page = j.nextPageToken ?? ''
    if (!page) break
  }
  return out.sort()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const DROP = new Set(['$schema', 'additionalProperties', '$id', '$ref', '$defs', 'definitions', 'default', 'examples', 'title'])
function cleanSchema(s: Any): Any {
  if (Array.isArray(s)) return s.map(cleanSchema)
  if (!s || typeof s !== 'object') return s
  const o: Any = {}
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k)) continue
    if (k === 'type' && Array.isArray(v)) {
      o.type = String((v as string[]).find((t) => t !== 'null') ?? 'string')
      continue
    }
    o[k] = cleanSchema(v)
  }
  return o
}

const SIG = '__sig_'
function packId(id: string, sig?: string): string {
  return sig ? id + SIG + Buffer.from(sig).toString('base64url') : id
}
function unpackSig(id: string): string | undefined {
  const i = id.indexOf(SIG)
  return i < 0 ? undefined : Buffer.from(id.slice(i + SIG.length), 'base64url').toString()
}

function textOf(c: Any): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('')
  return c == null ? '' : String(c)
}

function userParts(c: Any): Any[] {
  if (typeof c === 'string') return [{ text: c }]
  const parts: Any[] = []
  for (const p of Array.isArray(c) ? c : []) {
    if (p?.type === 'text') parts.push({ text: p.text })
    else if (p?.type === 'image_url') {
      const u = String(p.image_url?.url ?? p.image_url ?? '')
      const m = /^data:([^;]+);base64,(.*)$/.exec(u)
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } })
    }
  }
  return parts.length ? parts : [{ text: '' }]
}

function toNative(body: Any): Any {
  const msgs: Any[] = body.messages ?? []
  const names = new Map<string, string>()
  const sys: string[] = []
  const contents: Any[] = []
  for (const m of msgs) {
    if (m.role === 'system' || m.role === 'developer') {
      sys.push(textOf(m.content))
    } else if (m.role === 'assistant') {
      const parts: Any[] = []
      const t = textOf(m.content)
      if (t) parts.push({ text: t })
      for (const tc of m.tool_calls ?? []) {
        names.set(tc.id, tc.function.name)
        let args: Any = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {
          /* keep empty */
        }
        const p: Any = { functionCall: { name: tc.function.name, args } }
        const sig = unpackSig(String(tc.id))
        if (sig) p.thoughtSignature = sig
        parts.push(p)
      }
      if (parts.length) contents.push({ role: 'model', parts })
    } else if (m.role === 'tool') {
      const part = { functionResponse: { name: names.get(m.tool_call_id) ?? m.name ?? 'tool', response: { result: textOf(m.content) } } }
      const last = contents[contents.length - 1]
      if (last && last.role === 'user' && last.parts.every((p: Any) => p.functionResponse)) last.parts.push(part)
      else contents.push({ role: 'user', parts: [part] })
    } else {
      contents.push({ role: 'user', parts: userParts(m.content) })
    }
  }
  const out: Any = { contents }
  if (sys.length) out.systemInstruction = { parts: [{ text: sys.join('\n\n') }] }
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = [
      {
        functionDeclarations: body.tools
          .filter((t: Any) => t.type === 'function')
          .map((t: Any) => ({ name: t.function.name, description: t.function.description ?? '', ...(t.function.parameters && Object.keys(t.function.parameters.properties ?? {}).length ? { parameters: cleanSchema(t.function.parameters) } : {}) }))
      }
    ]
  }
  const gc: Any = {}
  const mx = body.max_completion_tokens ?? body.max_tokens
  if (mx) gc.maxOutputTokens = mx
  if (body.temperature != null) gc.temperature = body.temperature
  if (body.top_p != null) gc.topP = body.top_p
  if (body.stop) gc.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') gc.responseMimeType = 'application/json'
  if (Object.keys(gc).length) out.generationConfig = gc
  return out
}

function finish(r: string | undefined, hasTools: boolean): string {
  if (hasTools) return 'tool_calls'
  if (r === 'MAX_TOKENS') return 'length'
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT') return 'content_filter'
  return 'stop'
}

function usageOf(u: Any): Any {
  const p = u?.promptTokenCount ?? 0
  const c = (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0)
  return { prompt_tokens: p, completion_tokens: c, total_tokens: u?.totalTokenCount ?? p + c }
}

function readParts(cand: Any, startIdx: number): { text: string; calls: Any[] } {
  let text = ''
  const calls: Any[] = []
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) continue
    if (typeof p.text === 'string') text += p.text
    if (p.functionCall) {
      const idx = startIdx + calls.length
      calls.push({ index: idx, id: packId('call_' + Date.now().toString(36) + idx, p.thoughtSignature), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } })
    }
  }
  return { text, calls }
}

function json(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

/** fetch for the OpenAI SDK: turns /chat/completions into native Gemini calls. */
export const googleNativeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (!/\/chat\/completions(\?|$)/.test(url)) return json(404, { error: { message: 'unsupported endpoint for Google account: ' + url, code: 404 } })
  const body = JSON.parse(String(init?.body ?? '{}')) as Any
  const model = String(body.model ?? '').replace(/^models\//, '')
  const native = JSON.stringify(toNative(body))
  const headers = await authHeaders()
  const signal = init?.signal ?? undefined
  const stream = body.stream === true
  const endpoint = `${BASE}/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
  const res = await fetch(endpoint, { method: 'POST', headers, body: native, signal })
  if (!res.ok) return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
  const id = 'chatcmpl-' + Date.now().toString(36)
  const created = Math.floor(Date.now() / 1000)
  if (!stream) {
    const j = (await res.json()) as Any
    const cand = j.candidates?.[0]
    const { text, calls } = readParts(cand, 0)
    return json(200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, finish_reason: finish(cand?.finishReason, calls.length > 0), message: { role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls.map(({ index: _i, ...c }) => c) } : {}) } }],
      usage: usageOf(j.usageMetadata)
    })
  }
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const reader = res.body!.getReader()
  let buf = ''
  let nCalls = 0
  let lastFinish: string | undefined
  let usage: Any
  const chunk = (delta: Any, fin: string | null = null, extra: Any = {}): Uint8Array =>
    enc.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: fin }], ...extra }) + '\n\n')
  const rs = new ReadableStream<Uint8Array>({
    async start(ctl) {
      ctl.enqueue(chunk({ role: 'assistant', content: '' }))
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '')
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const raw = line.slice(5).trim()
            if (!raw) continue
            let j: Any
            try {
              j = JSON.parse(raw)
            } catch {
              continue
            }
            if (j.usageMetadata) usage = j.usageMetadata
            const cand = j.candidates?.[0]
            if (cand?.finishReason) lastFinish = cand.finishReason
            const { text, calls } = readParts(cand, nCalls)
            if (text) ctl.enqueue(chunk({ content: text }))
            if (calls.length) {
              nCalls += calls.length
              ctl.enqueue(chunk({ tool_calls: calls }))
            }
          }
        }
        ctl.enqueue(chunk({}, finish(lastFinish, nCalls > 0), { usage: usageOf(usage) }))
        ctl.enqueue(enc.encode('data: [DONE]\n\n'))
        ctl.close()
      } catch (e) {
        ctl.error(e)
      }
    },
    cancel() {
      void reader.cancel()
    }
  })
  return new Response(rs, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** One-shot native call used by the Test button. */
export async function googleGenerateOnce(model: string, prompt: string): Promise<string> {
  const r = await googleNativeFetch('https://x/chat/completions', { method: 'POST', signal: AbortSignal.timeout(25000), body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }) })
  const t = await r.text()
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.replace(/\s+/g, ' ').slice(0, 260))
  return String((JSON.parse(t) as Any).choices?.[0]?.message?.content ?? '')
}