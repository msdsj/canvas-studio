import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { EmptyState } from '@/components/ui/empty-state'
import { Button } from '@/components/ui/button'
import { useActiveTasks } from '@/hooks/use-active-tasks'
import { useToast } from '@/hooks/use-toast'
import { generateApi } from '@/lib/api/generate'
import { events } from '@/lib/events'
import { errorMessage } from '@/lib/errors'

/** 进行中任务中心（P1-13）：列表 + 进度 + 继续/放弃。 */
export function ActiveTasksPanel() {
  const { t } = useTranslation('chat')
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
      toast.fromError(error)
    }
  }

  if (activeTasks.length === 0) {
    return (
      <EmptyState icon={ListChecks} title={t('active_panel.empty')} className="py-16" />
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm text-text-secondary">{t('active_panel.count', { count: activeTasks.length })}</p>
      {activeTasks.map((task) => (
        <div key={task.id} className="rounded-lg border border-border bg-surface p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="truncate text-sm text-text">{task.prompt.slice(0, 40) || task.type}</span>
            <span className="text-xs text-text-tertiary">{t(`task.${task.status}`)}</span>
          </div>
          <Progress value={task.progress} tone={task.status === 'paused' ? 'warning' : 'brand'} />
          <div className="mt-2 flex gap-2">
            {task.status === 'paused' ? (
              <Button size="sm" variant="secondary" onClick={() => act(() => generateApi.resume(task.id), t('task.resume'))}>
                {t('task.resume')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => act(() => generateApi.pause(task.id), t('task.pause'))}>
                {t('task.pause')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => act(() => generateApi.cancel(task.id), t('task.cancelled'))}>
              {t('task.cancel')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
