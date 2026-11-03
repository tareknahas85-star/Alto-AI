import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Download, FileText, Link2, Loader2, Play, Plus, Trash2, X } from 'lucide-react'
import { Empty, PageShell, cardCls, ghostBtn, inputCls, primaryBtn } from './components/ui'
import { Markdown } from './Markdown'
import { renderSlideVideo } from './slide-video'
import { askConfirm } from './components/confirm'
import { extractMermaid, csvOf, parseCsv, parseDeck, parseDialogue, parseFlashcards, parseInfographic, parseQuiz } from '../core/notebook'

type NbView = NonNullable<Awaited<ReturnType<typeof window.api.nb.get>>>
type Note = NbView['notes'][number]
type Kind = 'report' | 'table' | 'mindmap' | 'flashcards' | 'quiz' | 'slides' | 'infographic' | 'audio'

const KINDS: { id: Kind; label: string }[] = [
  { id: 'report', label: 'تقرير' },
  { id: 'table', label: 'جدول بيانات' },
  { id: 'mindmap', label: 'خريطة ذهنية' },
  { id: 'flashcards', label: 'بطاقات مراجعة' },
  { id: 'quiz', label: 'اختبار' },
  { id: 'slides', label: 'عرض تقديمي' },
  { id: 'infographic', label: 'إنفوغرافيك' },
  { id: 'audio', label: 'ملخّص صوتي' }
]

// Mermaid mindmap text -> nested list (no external library): indentation gives the depth.
type TreeNode = { text: string; kids: TreeNode[] }
function mindTree(src: string): TreeNode | null {
  const lines = src.split('\n').slice(1).filter((l) => l.trim())
  if (!lines.length) return null
  const clean = (t: string): string => t.trim().replace(/^[\w-]*[(\[{]+/, '').replace(/[)\]}]+$/, '').replace(/^["']|["']$/g, '').trim() || t.trim()
  const root: TreeNode = { text: '', kids: [] }
  const stack: { ind: number; node: TreeNode }[] = [{ ind: -1, node: root }]
  for (const l of lines) {
    const ind = l.length - l.trimStart().length
    const node: TreeNode = { text: clean(l), kids: [] }
    while (stack.length > 1 && stack[stack.length - 1].ind >= ind) stack.pop()
    stack[stack.length - 1].node.kids.push(node)
    stack.push({ ind, node })
  }
  return root.kids.length === 1 ? root.kids[0] : root
}

function Tree({ n, depth = 0 }: { n: TreeNode; depth?: number }) {
  return (
    <li className="my-1">
      <span className={depth === 0 ? 'rounded-lg bg-primary px-3 py-1 text-white' : depth === 1 ? 'rounded-lg bg-surface2 px-2 py-0.5 font-medium' : 'text-sm text-muted'}>{n.text || '…'}</span>
      {n.kids.length > 0 && <ul className="mr-5 mt-1 border-r border-outline pr-3">{n.kids.map((k, i) => <Tree key={i} n={k} depth={depth + 1} />)}</ul>}
    </li>
  )
}

function Cards({ body }: { body: string }) {
  const cards = useMemo(() => parseFlashcards(body), [body])
  const [i, setI] = useState(0)
  const [flip, setFlip] = useState(false)
  if (!cards.length) return <Markdown text={body} />
  const c = cards[i]
  return (
    <div>
      <button onClick={() => setFlip(!flip)} className="flex min-h-[140px] w-full items-center justify-center rounded-card border border-outline bg-surface2 p-6 text-center text-lg">
        {flip ? c.a : c.q}
      </button>
      <div className="mt-2 flex items-center justify-between text-sm text-muted">
        <button className={ghostBtn} disabled={i === 0} onClick={() => { setI(i - 1); setFlip(false) }}>السابقة</button>
        <span>{i + 1} / {cards.length} — اضغط البطاقة لتقلبها</span>
        <button className={ghostBtn} disabled={i === cards.length - 1} onClick={() => { setI(i + 1); setFlip(false) }}>التالية</button>
      </div>
    </div>
  )
}

function Quiz({ body }: { body: string }) {
  const qs = useMemo(() => parseQuiz(body), [body])
  const [pick, setPick] = useState<Record<number, number>>({})
  if (!qs.length) return <Markdown text={body} />
  const done = Object.keys(pick).length === qs.length
  const score = qs.filter((q, i) => pick[i] === q.answer).length
  return (
    <div className="space-y-4">
      {qs.map((q, qi) => (
        <div key={qi}>
          <div className="mb-1 font-medium">{qi + 1}. {q.q}</div>
          <div className="space-y-1">
            {q.options.map((o, oi) => {
              const chosen = pick[qi] !== undefined
              const cls = !chosen ? 'hover:bg-surface2' : oi === q.answer ? 'bg-green-500/15' : pick[qi] === oi ? 'bg-red-500/15' : ''
              return <button key={oi} disabled={chosen} onClick={() => setPick({ ...pick, [qi]: oi })} className={'block w-full rounded-lg border border-outline px-3 py-2 text-right text-sm ' + cls}>{o}</button>
            })}
          </div>
          {pick[qi] !== undefined && q.why && <div className="mt-1 text-xs text-muted">{q.why}</div>}
        </div>
      ))}
      {done && <div className="rounded-lg bg-surface2 p-3 text-center font-medium">النتيجة: {score} من {qs.length}</div>}
    </div>
  )
}

function Table({ body }: { body: string }) {
  const csv = csvOf(body)
  if (!csv) return <Markdown text={body} />
  const rows = parseCsv(csv)
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead><tr>{rows[0].map((h, i) => <th key={i} className="border border-outline bg-surface2 px-2 py-1 text-right">{h}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-outline px-2 py-1">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function MindMap({ body }: { body: string }) {
  const m = extractMermaid(body)
  const tree = m ? mindTree(m) : null
  if (!tree) return <Markdown text={body} />
  return <ul className="text-sm"><Tree n={tree} /></ul>
}

function Slides({ nbId, noteId, body }: { nbId: string; noteId: string; body: string }) {
  const d = parseDeck(body)
  const [prog, setProg] = useState('')
  const [vurl, setVurl] = useState('')
  const [vblob, setVblob] = useState<Blob | null>(null)
  const [verr, setVerr] = useState('')
  const [saved, setSaved] = useState('')
  if (!d) return <Markdown text={body} />
  const make = async (): Promise<void> => {
    setVerr(''); setSaved(''); setProg('عم جهّز التعليق الصوتي...')
    try {
      const a = await window.api.nb.slideAudio(nbId, noteId)
      if (!a.ok || !a.urls) throw new Error(a.error ?? 'تعذّر تجهيز الصوت')
      const blob = await renderSlideVideo(d, a.urls, (k, t) => setProg('عم سجّل الفيديو بالوقت الحقيقي: ' + k + ' / ' + t))
      if (vurl) URL.revokeObjectURL(vurl)
      setVblob(blob); setVurl(URL.createObjectURL(blob)); setProg('')
    } catch (e) { setProg(''); setVerr((e as Error).message) }
  }
  const save = async (): Promise<void> => {
    if (!vblob) return
    const buf = new Uint8Array(await vblob.arrayBuffer())
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    const r = await window.api.nb.saveVideo(d.title, btoa(bin))
    setSaved(r.ok ? 'انحفظ: ' + r.path : r.error === 'انلغى' ? '' : r.error ?? '')
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button className={ghostBtn} disabled={!!prog} onClick={() => void make()}>{prog ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} حوّلو لفيديو (مجاني، محلي)</button>
        {vblob && <button className={ghostBtn} onClick={() => void save()}><Download className="h-4 w-4" /> احفظ الفيديو (webm)</button>}
        {prog && <span className="text-xs text-muted">{prog}</span>}
        {verr && <span className="text-xs text-danger">{verr}</span>}
        {saved && <span className="text-xs text-muted">{saved}</span>}
      </div>
      {vurl && <video controls src={vurl} className="w-full rounded-lg" />}
      {d.slides.map((s, i) => (
        <div key={i} className="rounded-lg border border-outline p-3 text-sm">
          <div className="mb-1 font-medium">{i + 1}. {s.title}</div>
          {s.bullets.length > 0 && <ul className="list-disc pr-5 text-muted">{s.bullets.map((b, j) => <li key={j}>{b}</li>)}</ul>}
        </div>
      ))}
    </div>
  )
}

function Info({ body }: { body: string }) {
  const i = parseInfographic(body)
  if (!i) return <Markdown text={body} />
  return (
    <div className="space-y-3 text-sm">
      {i.stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {i.stats.map((s, k) => (
            <div key={k} className="rounded-lg bg-surface2 p-3 text-center"><div className="text-2xl font-bold text-primary">{s.value}</div><div className="text-xs text-muted">{s.label}</div></div>
          ))}
        </div>
      )}
      {i.sections.map((s, k) => (
        <div key={k} className="rounded-lg border border-outline p-3"><div className="mb-1 font-medium">{s.heading}</div><ul className="list-disc pr-5 text-muted">{s.points.map((p, j) => <li key={j}>{p}</li>)}</ul></div>
      ))}
      {i.takeaway && <div className="rounded-lg bg-surface2 p-3 font-medium">{i.takeaway}</div>}
    </div>
  )
}

function AudioNote({ nbId, noteId, body }: { nbId: string; noteId: string; body: string }) {
  const lines = parseDialogue(body)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!lines.length) return <Markdown text={body} />
  const make = async (): Promise<void> => {
    setBusy(true); setErr('')
    const r = await window.api.nb.audio(nbId, noteId)
    setBusy(false)
    if (r.ok && r.url) setUrl(r.url); else setErr(r.error ?? 'فشل توليد الصوت')
  }
  return (
    <div className="space-y-2 text-sm">
      <div>
        {url ? <audio controls autoPlay src={url} className="w-full" /> : (
          <button className={ghostBtn + ' border border-outline'} disabled={busy} onClick={() => void make()}>{busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} {busy ? 'عم يتجهّز الصوت...' : 'شغّل الملخّص'}</button>
        )}
        {err && <div className="mt-1 text-xs text-danger">{err}</div>}
      </div>
      <div className="max-h-64 space-y-1 overflow-auto">
        {lines.map((l, i) => <div key={i}><span className="font-medium">{l.who === 'A' ? 'أمل' : 'ليث'}: </span><span className="text-muted">{l.text}</span></div>)}
      </div>
    </div>
  )
}

function NoteCard({ nb, note, onChange }: { nb: NbView; note: Note; onChange: (v: NbView | null) => void }) {
  const [msg, setMsg] = useState('')
  return (
    <div className={cardCls}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-medium">{note.kind === 'answer' ? 'س: ' + note.title : note.title}</div>
        <div className="flex gap-1">
          <button title="تصدير" className={ghostBtn} onClick={() => void window.api.nb.exportNote(nb.id, note.id).then((r) => setMsg(r.ok ? 'انحفظ: ' + r.path : r.error === 'انلغى' ? '' : r.error ?? ''))}><Download size={16} /></button>
          <button title="حذف" className={ghostBtn} onClick={() => void window.api.nb.deleteNote(nb.id, note.id).then(onChange)}><Trash2 size={16} /></button>
        </div>
      </div>
      {note.kind === 'table' ? <Table body={note.body} /> : note.kind === 'mindmap' ? <MindMap body={note.body} /> : note.kind === 'flashcards' ? <Cards body={note.body} /> : note.kind === 'quiz' ? <Quiz body={note.body} /> : note.kind === 'slides' ? <Slides nbId={nb.id} noteId={note.id} body={note.body} /> : note.kind === 'infographic' ? <Info body={note.body} /> : note.kind === 'audio' ? <AudioNote nbId={nb.id} noteId={note.id} body={note.body} /> : <Markdown text={note.body} />}
      {msg && <div className="mt-2 text-xs text-muted">{msg}</div>}
    </div>
  )
}

export function NotebookPage() {
  const [list, setList] = useState<{ id: string; title: string; sources: number; notes: number }[]>([])
  const [nb, setNb] = useState<NbView | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const [link, setLink] = useState('')
  const [focus, setFocus] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)

  const refresh = (): void => void window.api.nb.list().then(setList)
  useEffect(refresh, [])
  const open = (id: string): void => void window.api.nb.get(id).then((v) => { setNb(v); setErr('') })
  const apply = (v: NbView | null): void => { setNb(v); refresh() }
  const wrap = async (label: string, f: () => Promise<{ ok: boolean; nb?: NbView | null; error?: string; skipped?: string[] }>): Promise<void> => {
    setBusy(label); setErr('')
    try {
      const r = await f()
      if (r.nb) apply(r.nb)
      if (!r.ok) setErr(r.error ?? 'صار خطأ')
      else if (r.skipped?.length) setErr('تخطّيت: ' + r.skipped.join('، '))
    } finally { setBusy('') }
  }

  if (!nb) {
    return (
      <PageShell title="دفتر" subtitle="حط مصادرك (ملفات، روابط، نصوص) واسألها أو حوّلها لتقرير، جدول، خريطة ذهنية، بطاقات واختبار — الإجابات مبنية على مصادرك بس ومعها أرقام المصادر." action={<button className={primaryBtn} onClick={() => void window.api.nb.create('').then((v) => { refresh(); setNb(v) })}><Plus size={14} className="ml-1 inline" />دفتر جديد</button>}>
        {list.length === 0 ? <Empty text="ما في دفاتر لسا — اضغط «دفتر جديد»." /> : (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((n) => (
              <div key={n.id} className={cardCls + ' cursor-pointer hover:border-primary'} onClick={() => open(n.id)}>
                <div className="flex items-center gap-2 font-medium"><BookOpen size={16} />{n.title}</div>
                <div className="mt-1 text-xs text-muted">{n.sources} مصدر · {n.notes} ملاحظة</div>
              </div>
            ))}
          </div>
        )}
      </PageShell>
    )
  }

  const has = nb.sources.length > 0
  return (
    <PageShell
      title={nb.title}
      subtitle={`${nb.sources.length} مصدر`}
      action={<div className="flex gap-2"><button className={ghostBtn} onClick={() => setRenaming(nb.title)}>تسمية</button><button className={ghostBtn} onClick={() => void askConfirm('حذف هالدفتر ومصادره؟', { danger: true }).then((ok) => { if (ok) void window.api.nb.remove(nb.id).then(() => { setNb(null); refresh() }) })}>حذف</button><button className={ghostBtn} onClick={() => { setNb(null); refresh() }}>رجوع</button></div>}
    >
      {renaming !== null && (
        <div className={cardCls + ' mb-3 flex gap-2'}>
          <input className={inputCls} value={renaming} onChange={(e) => setRenaming(e.target.value)} />
          <button className={primaryBtn} onClick={() => void window.api.nb.rename(nb.id, renaming).then(() => { setRenaming(null); open(nb.id); refresh() })}>حفظ</button>
          <button className={ghostBtn} onClick={() => setRenaming(null)}>إلغاء</button>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="space-y-3">
          <div className={cardCls}>
            <div className="mb-2 font-medium">المصادر</div>
            {nb.sources.length === 0 && <div className="text-sm text-muted">ما في مصادر لسا.</div>}
            <ul className="space-y-1">
              {nb.sources.map((s, i) => (
                <li key={s.id} className="flex items-center justify-between gap-1 rounded-lg bg-surface2 px-2 py-1 text-sm">
                  <span className="truncate" title={s.name}>[{i + 1}] {s.name}</span>
                  <button className="text-muted hover:text-red-500" onClick={() => void window.api.nb.removeSource(nb.id, s.id).then(apply)}><X size={14} /></button>
                </li>
              ))}
            </ul>
            <div className="mt-3 space-y-2">
              <button disabled={!!busy} className={ghostBtn + ' w-full border border-outline'} onClick={() => void wrap('files', () => window.api.nb.addFiles(nb.id))}><FileText size={14} className="ml-1 inline" />ضيف ملفات</button>
              <button className={ghostBtn + ' w-full border border-outline'} onClick={() => setPasteOpen(!pasteOpen)}>الصق نص</button>
              {pasteOpen && (
                <div className="space-y-2">
                  <textarea className={inputCls + ' h-28'} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="الصق النص هون" />
                  <button className={primaryBtn} disabled={!paste.trim() || !!busy} onClick={() => void wrap('text', () => window.api.nb.addText(nb.id, '', paste)).then(() => { setPaste(''); setPasteOpen(false) })}>إضافة</button>
                </div>
              )}
              <div className="flex gap-1">
                <input className={inputCls} dir="ltr" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://..." />
                <button className={ghostBtn + ' border border-outline'} disabled={!link.trim() || !!busy} onClick={() => void wrap('link', () => window.api.nb.addLink(nb.id, link)).then(() => setLink(''))}><Link2 size={14} /></button>
              </div>
            </div>
          </div>
          <div className={cardCls}>
            <div className="mb-2 font-medium">حوّل المصادر إلى</div>
            <input className={inputCls + ' mb-2'} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="تركيز اختياري (مثلاً: المخاطر)" />
            <div className="flex flex-wrap gap-2">
              {KINDS.map((k) => <button key={k.id} disabled={!has || !!busy} className={ghostBtn + ' border border-outline'} onClick={() => void wrap(k.id, () => window.api.nb.generate(nb.id, k.id, focus))}>{k.label}</button>)}
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <div className={cardCls}>
            <div className="flex gap-2">
              <input className={inputCls} value={q} disabled={!has} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && q.trim() && !busy) void wrap('ask', () => window.api.nb.ask(nb.id, q)).then(() => setQ('')) }} placeholder={has ? 'اسأل مصادرك…' : 'ضيف مصدر أول'} />
              <button className={primaryBtn} disabled={!has || !q.trim() || !!busy} onClick={() => void wrap('ask', () => window.api.nb.ask(nb.id, q)).then(() => setQ(''))}>اسأل</button>
            </div>
            {busy && <div className="mt-2 text-sm text-muted">عم اشتغل… ({busy})</div>}
            {err && <div className="mt-2 text-sm text-red-500">{err}</div>}
          </div>
          {nb.notes.length === 0 ? <Empty text="الإجابات والمخرجات رح تظهر هون." /> : nb.notes.map((n) => <NoteCard key={n.id} nb={nb} note={n} onChange={apply} />)}
        </div>
      </div>
    </PageShell>
  )
}
