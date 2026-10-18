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

/**
 * 通知铃铛：未读生成结果提醒。
 *
 * 三种形态：
 * - 默认：18px 图标按钮（顶栏用）
 * - `compact`：上下布局（铃铛在上、数字在下），约 36px 宽
 * - `iconOnly`：单颗 28px 图标 + 右上角数字角标，用于和主题/语言并排成一行
 */
export function NotificationBell({
  compact = false,
  iconOnly = false,
}: {
  compact?: boolean
  iconOnly?: boolean
}) {
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

  const menuContent = (
    <DropdownMenuContent align="end" className="w-72">
      <DropdownMenuLabel>{t('notifications.title')}</DropdownMenuLabel>
      {unreadTasks.length === 0 ? (
        <div className="px-2.5 py-6 text-center text-sm text-text-tertiary">
          {t('notifications.empty')}
        </div>
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
  )

  if (iconOnly) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative flex h-7 w-7 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            aria-label={t('notifications.title')}
            title={t('notifications.title')}
          >
            <Bell size={15} />
            {unreadTasks.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold leading-none text-[color:var(--color-danger-subtle)]">
                {unreadTasks.length > 9 ? '9+' : unreadTasks.length}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    )
  }

  if (compact) {
    return (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative flex h-9 w-9 flex-col items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            aria-label={t('notifications.title')}
          >
            <Bell size={12} />
            <span className="text-[10px] font-semibold leading-none tabular-nums text-text-tertiary">
              {unreadTasks.length > 9 ? '9+' : unreadTasks.length}
            </span>
            {unreadTasks.length > 0 && (
              <span className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-danger" />
            )}
          </button>
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('notifications.title')} className="relative">
          <Bell size={18} />
          {unreadTasks.length > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium text-[color:var(--color-danger-subtle)]">
              {unreadTasks.length > 9 ? '9+' : unreadTasks.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      {menuContent}
    </DropdownMenu>
  )
}
