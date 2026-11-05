import { useEffect, useState, type ReactElement } from 'react'
import { Modal } from './components/ui'
import changelog from '../../CHANGELOG.md?raw'
import { latestNotes } from '../core/changelog'

// النسخة والنقاط بتنقرا من أول قسم بالـCHANGELOG وقت البناء.
const REL = latestNotes(changelog)
const VERSION = REL?.version ?? ''
const NOTES: string[] = REL?.notes ?? []
const SEEN = 'air.whatsnew.seen'

export function WhatsNew(): ReactElement | null {
  const [open, setOpen] = useState(() => {
    try {
      return !!VERSION && NOTES.length > 0 && localStorage.getItem(SEEN) !== VERSION
    } catch {
      return false
    }
  })
  useEffect(() => {
    const h = (): void => setOpen(true)
    window.addEventListener('air:whatsnew', h)
    return () => window.removeEventListener('air:whatsnew', h)
  }, [])
  if (!open || !NOTES.length) return null
  const close = (): void => {
    setOpen(false)
    try {
      localStorage.setItem(SEEN, VERSION)
    } catch {
      /* storage unavailable */
    }
  }
  return (
    <Modal title={`شو الجديد بنسخة ${VERSION}`} onClose={close}>
      <ul className="list-disc space-y-2 ps-5 text-sm" dir="rtl">
        {NOTES.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <div className="mt-5 flex justify-start">
        <button onClick={close} className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-white shadow-card hover:opacity-90">
          تمام
        </button>
      </div>
    </Modal>
  )
}
