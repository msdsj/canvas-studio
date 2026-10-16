import { api } from './client'
import type { GenerationTask } from '@/types/models'

export const tasksApi = {
  /** 活跃任务（queued/running/paused）——刷新续接 */
  listActive: () => api.get<GenerationTask[]>('/tasks/active'),
  /** 已完成未读结果 */
  listUnread: () => api.get<GenerationTask[]>('/tasks/unread'),
}
