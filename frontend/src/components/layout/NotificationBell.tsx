import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActiveTasks } from '@/hooks/use-active-tasks'
import { generateApi } from '@/lib/api/generate'
import { events } from '@/lib/events'
import { formatRelative } from '@/lib/utils'

/** 通知铃铛：未读生成结果提醒（P0-31 / P1-14）。 */
export function NotificationBell() {
  const { t } = useTranslation('workspace')
  const { unreadTasks, refreshUnread } = useActiveTasks()
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  const handleOpenTask = async (taskId: string) => {
    try {
      await generateApi.markSeen(taskId)
      events.emit('tasks:changed')
      void refreshUnread()
    } catch {
      /* ignore */
    }
    setOpen(false)
    void navigate({ to: '/workspace', search: { task: taskId } as never })
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('notifications.title')} className="relative">
          <Bell size={18} />
          {unreadTasks.length > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium text-white">
              {unreadTasks.length > 9 ? '9+' : unreadTasks.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>{t('notifications.title')}</DropdownMenuLabel>
        {unreadTasks.length === 0 ? (
          <div className="px-2.5 py-6 text-center text-sm text-text-tertiary">{t('notifications.empty')}</div>
        ) : (
          unreadTasks.slice(0, 8).map((task) => (
            <DropdownMenuItem key={task.id} onClick={() => handleOpenTask(task.id)}>
              <span className="truncate">
                {task.prompt.slice(0, 24) || task.type}
                <span className="ml-2 text-xs text-text-tertiary">{formatRelative(task.created_at)}</span>
              </span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
