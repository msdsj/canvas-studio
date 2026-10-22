import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { ImageDown, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useActiveTasks } from '@/hooks/use-active-tasks'
import { generateApi } from '@/lib/api/generate'
import { events } from '@/lib/events'
import { useState } from 'react'

/** 未读结果提醒条（P0-31 / P1-14）：点击定位到对应画布任务。 */
export function UnreadResultsBanner() {
  const { t } = useTranslation('chat')
  const { unreadTasks, refreshUnread } = useActiveTasks()
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(false)

  const standaloneTasks = unreadTasks.filter((task) => !task.canvas_id)
  if (dismissed || standaloneTasks.length === 0) return null
  const latest = standaloneTasks[0]

  const locate = async () => {
    try {
      await generateApi.markSeen(latest.id)
      events.emit('tasks:changed')
      void refreshUnread()
    } catch {
      /* ignore */
    }
    void navigate({ to: '/workspace', search: { task: latest.id } as never })
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-brand-subtle px-4 py-2 text-sm text-brand-text">
      <ImageDown size={16} />
      <span>{t('unread_banner.text', { count: standaloneTasks.length })}</span>
      <div className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={locate}>
          {t('unread_banner.locate')}
        </Button>
        <button
          type="button"
          aria-label="dismiss"
          className="rounded p-1 hover:bg-black/5"
          onClick={() => setDismissed(true)}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
