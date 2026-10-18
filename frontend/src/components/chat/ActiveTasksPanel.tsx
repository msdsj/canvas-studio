import { useTranslation } from 'react-i18next'
import { CircleStop, ListChecks } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { useActiveTasks } from '@/hooks/use-active-tasks'
import { useToast } from '@/hooks/use-toast'
import { generateApi } from '@/lib/api/generate'
import { events } from '@/lib/events'
import { errorMessage } from '@/lib/errors'

/**
 * 进行中任务中心：列表 + 停止。
 *
 * 不展示百分比：后端进度只有 0/30/100 三个值，中间会长时间冻结在 30%，
 * 用户看到"卡在 30%"会认定产品挂了。改用不确定态细条。
 * 也不提供「暂停/继续」：暂停不中断上游，只会白烧一次调用。
 */
export function ActiveTasksPanel() {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation()
  const { activeTasks, refresh } = useActiveTasks()
  const toast = useToast()

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast.success(ok)
      events.emit('tasks:changed')
      events.emit('quota:changed')
      void refresh()
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  if (activeTasks.length === 0) {
    return <EmptyState icon={ListChecks} title={t('active_panel.empty')} className="py-16" />
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm text-text-secondary">
        {t('active_panel.count', { count: activeTasks.length })}
      </p>
      {activeTasks.map((task) => (
        <div key={task.id} className="rounded-lg border border-border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-sm text-text">{task.prompt.slice(0, 40) || task.type}</span>
            <span className="shrink-0 text-xs text-text-tertiary">
              {t(`task.${task.status === 'paused' ? 'cancelled' : task.status}`)}
            </span>
          </div>
          <div className="h-1.5 w-full animate-pulse rounded-full bg-brand/30" />
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => act(() => generateApi.cancel(task.id), t('task.cancelled'))}
            >
              <CircleStop size={14} /> {t('task.stop')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
