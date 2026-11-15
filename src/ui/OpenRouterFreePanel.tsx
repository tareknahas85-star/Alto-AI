import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { estimateStrength } from '../core/model-rank'
import { CapIcons } from './Caps'
import { Chip, Toggle, cardCls, ghostBtn } from './components/ui'

type CM = { id: string; name: string; tier: string; context: number; vision: boolean; tools?: boolean; reasoning?: boolean; enabled: boolean }

// 5.21.10: نفس فكرة بلوك APInex: زر واحد لتحديث قائمة OpenRouter، وقايمة المجاني مرتبة من الأقوى، وتفعيل بضغطة.
export function OpenRouterFreePanel() {
  const [models, setModels] = useState<CM[]>([])
  const [fetchedAt, setFetchedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [fresh, setFresh] = useState<Set<string>>(new Set())

  const load = useCallback(async (): Promise<CM[]> => {
    const c = await window.api.catalog.list()
    setModels(c.models)
    setFetchedAt(c.fetchedAt)
    return c.models as CM[]
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const before = new Set((await window.api.catalog.list()).models.map((m: CM) => m.id))
      const r = await window.api.catalog.fetch()
      const after = await load()
      if (r.ok) {
        const added = new Set(after.filter((m) => !before.has(m.id) && m.tier === 'TIER_1_FREE').map((m) => m.id))
        setFresh(added)
        const free = after.filter((m) => m.tier === 'TIER_1_FREE').length
        setMsg(`✅ ${free} موديل مجاني (${added.size} جديد مجاني) من ${r.total} موديل`)
      } else setMsg('❌ ' + r.message)
    } finally {
      setBusy(false)
    }
  }, [load])

  useEffect(() => {
    void load().then(() => undefined)
    void window.api.catalog.list().then((c) => {
      if (c.fetchedAt === 0 || Date.now() - c.fetchedAt > 3600_000) void refresh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const free = useMemo(
    () => models.filter((m) => m.tier === 'TIER_1_FREE').sort((a, b) => estimateStrength(b.id) - estimateStrength(a.id)),
    [models]
  )
  const offTools = free.filter((m) => m.tools && !m.enabled)
  const set = async (ids: string[], on: boolean): Promise<void> => {
    await window.api.catalog.setEnabled(ids, on)
    await load()
  }

  return (
    <div className={cardCls + ' mb-4'}>
      <h3 className="mb-1 text-sm font-semibold">موديلات OpenRouter المجانية</h3>
      <p className="mb-3 text-xs text-muted">
        اضغط «حدّث الآن» لتسحب آخر الموديلات. المجانية بتظهر تحت مرتبة من الأقوى (الدرجة تقدير من الاسم والحجم). شغّل يلي بدك ياه بالمفتاح جنبو.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button className={ghostBtn} onClick={() => void refresh()} disabled={busy}>
          {busy ? <Loader2 size={14} className="inline animate-spin" /> : null} {busy ? 'جاري التحديث…' : 'حدّث قائمة OpenRouter الآن'}
        </button>
        {offTools.length > 0 && (
          <button className={ghostBtn} onClick={() => void set(offTools.map((m) => m.id), true)}>
            فعّل كل المجاني يلي بيدعم الأدوات ({offTools.length})
          </button>
        )}
        <span className="text-xs text-muted">
          {free.length} مجاني · {free.filter((m) => m.enabled).length} مفعّل
          {fetchedAt > 0 ? ' · آخر سحب: ' + new Date(fetchedAt).toLocaleString() : ''}
        </span>
      </div>
      {msg && <p className="mt-2 text-xs">{msg}</p>}
      {free.length > 0 && (
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto pe-1">
          {free.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 hover:bg-surface2">
              <div className="min-w-0">
                <div dir="ltr" className="truncate text-start font-mono text-xs">
                  {m.id} <span className="text-[10px] text-muted">· {Math.round(estimateStrength(m.id))}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {fresh.has(m.id) && <Chip cls="bg-success/15 text-success">جديد</Chip>}
                  {m.context > 0 && <Chip>{Math.round(m.context / 1000)}K</Chip>}
                  <CapIcons caps={{ vision: m.vision, tools: m.tools, reasoning: m.reasoning }} />
                </div>
              </div>
              <Toggle checked={m.enabled} label={`تفعيل ${m.id}`} onChange={() => void set([m.id], !m.enabled)} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        القائمة بتتحدّث لحالها كل 6 ساعات، والموديل المجاني الجديد يلي بيدعم الأدوات بيتفعّل تلقائياً. المدفوعة بتضل مطفية لحد ما تفعّلها من «موديلات مفتاح OpenRouter» تحت.
      </p>
    </div>
  )
}
