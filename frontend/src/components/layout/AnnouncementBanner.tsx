import { useEffect, useState } from 'react'
import { Info, X, TriangleAlert } from 'lucide-react'
import { announcementsApi } from '@/lib/api/announcements'
import type { Announcement } from '@/types/models'

/** 顶部公告条（可关闭）。 */
export function AnnouncementBanner() {
  const [items, setItems] = useState<Announcement[]>([])
  const [closed, setClosed] = useState<string[]>([])

  useEffect(() => {
    let active = true
    announcementsApi
      .listActive()
      .then((data) => active && setItems(data))
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const visible = items.filter((item) => !closed.includes(item.id))
  if (visible.length === 0) return null
  const current = visible[0]
  const isWarning = current.level === 'warning'
  const Icon = isWarning ? TriangleAlert : Info

  return (
    <div
      className={
        isWarning
          ? 'flex items-center gap-2 bg-warning-subtle px-4 py-2 text-sm text-warning'
          : 'flex items-center gap-2 bg-bg-subtle px-4 py-2 text-sm text-text-secondary'
      }
    >
      <Icon size={16} />
      <span className="font-medium">{current.title}</span>
      <span className="truncate opacity-90">{current.content}</span>
      <button
        type="button"
        aria-label="close"
        className="ml-auto rounded p-1 hover:bg-black/5"
        onClick={() => setClosed((prev) => [...prev, current.id])}
      >
        <X size={14} />
      </button>
    </div>
  )
}
