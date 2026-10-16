import { useEffect } from 'react'
import { tasksApi } from '@/lib/api/tasks'
import { events } from '@/lib/events'
import { useChatStore } from '@/stores/chat'
import { usePolling } from '@/hooks/use-polling'
import type { GenerationTask } from '@/types/models'

/**
 * 活跃任务轮询 + 刷新续接 + 未读结果。
 * 同步到 chat store 的 activeTaskIds（localStorage 持久化）。
 */
export function useActiveTasks(pollMs = 3000) {
  const activeTaskIds = useChatStore((s) => s.activeTaskIds)
  const setActiveTasks = useChatStore((s) => s.setActiveTasks)

  const { data: tasks, refresh: refreshActive } = usePolling<GenerationTask[]>(
    () => tasksApi.listActive(),
    { intervalMs: pollMs, backoff: true }
  )

  const { data: unread, refresh: refreshUnread } = usePolling<GenerationTask[]>(
    () => tasksApi.listUnread(),
    { intervalMs: pollMs * 2, backoff: true }
  )

  useEffect(() => {
    if (tasks) {
      setActiveTasks(tasks.map((task) => task.id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  useEffect(() => {
    const handler = () => {
      void refreshActive()
      void refreshUnread()
    }
    events.on('tasks:changed', handler)
    return () => events.off('tasks:changed', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    activeTasks: tasks ?? [],
    activeCount: tasks?.length ?? 0,
    activeTaskIds,
    unreadTasks: unread ?? [],
    unreadCount: unread?.length ?? 0,
    refreshActive,
    refreshUnread,
    refresh: () => {
      void refreshActive()
      void refreshUnread()
    },
  }
}
