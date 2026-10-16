import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { generateApi } from '@/lib/api/generate'
import { loadActiveTasks } from '@/lib/task-persistence'
import { useActiveTasks } from '@/hooks/use-active-tasks'
import { useToast } from '@/hooks/use-toast'
import { events } from '@/lib/events'

/**
 * 应用挂载时续接进行中任务：
 * - 启动活跃任务轮询（刷新后续接，P0-30/P0-35）
 * - 若上次留下的任务已完成，则 toast 提示（结果不丢失，P0-31）
 */
export function ResumeGuard() {
  const { t } = useTranslation('chat')
  const { refresh } = useActiveTasks()
  const toast = useToast()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const previous = loadActiveTasks()
    if (previous.length === 0) return

    const check = async () => {
      for (const id of previous) {
        try {
          const task = await generateApi.getTask(id)
          if (task.status === 'succeeded') {
            toast.success(t('task.succeeded'), task.prompt.slice(0, 40))
            events.emit('tasks:changed')
          }
        } catch {
          /* 任务可能已被清理 */
        }
      }
      void refresh()
    }
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
