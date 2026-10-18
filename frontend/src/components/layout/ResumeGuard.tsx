import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { generateApi } from '@/lib/api/generate'
import {
  loadActiveTasks,
  removeActiveTask,
  readNotifiedResults,
  writeNotifiedResults,
} from '@/lib/task-persistence'
import { useActiveTasks } from '@/hooks/use-active-tasks'
import { useToast } from '@/hooks/use-toast'
import { events } from '@/lib/events'

/**
 * 应用挂载时续接进行中任务：
 * - 启动活跃任务轮询（刷新后续接，P0-30/P0-35）
 * - 若上次留下的任务已完成，则 toast 提示（结果不丢失，P0-31）
 *
 * 去重与 ChatPanel 共用同一份记录（`cs.notifiedResults`）：
 * 之前这里另存一份 `cs.notifiedTasks`，结果是「同一条结果」在两个地方各弹一次，
 * 而且两边删库不同步。现在只有一处真源。
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
      let changed = false
      for (const id of previous) {
        try {
          const task = await generateApi.getTask(id)
          if (task.status !== 'succeeded' && task.status !== 'failed') continue

          if (task.status === 'succeeded') {
            const count = task.result_urls?.length ?? 0
            const notified = readNotifiedResults()
            // 只有「从未提示过」或「结果变多」才提醒
            if (count > 0 && count > (notified[id] ?? -1)) {
              notified[id] = count
              writeNotifiedResults(notified)
              toast.success(t('task.succeeded'), t('task.result_count', { count }))
            }
          }
          removeActiveTask(id)
          changed = true
        } catch {
          // 任务已被清理：直接从本地活跃列表移除，避免反复请求 404
          removeActiveTask(id)
          changed = true
        }
      }
      if (changed) events.emit('tasks:changed')
      void refresh()
    }
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
