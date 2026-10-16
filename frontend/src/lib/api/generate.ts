import { api } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { GenerationTask } from '@/types/models'

export interface GenerateImagePayload {
  prompt: string
  model?: string
  size?: string
  quality?: string
  n?: number
  session_id?: string
  canvas_id?: string
  params?: Record<string, unknown>
}

export interface GenerateEditPayload {
  prompt: string
  model?: string
  size?: string
  base_asset_id?: string
  session_id?: string
  canvas_id?: string
  file?: File
  mask?: File
  /** 归一化选区（单个或多个），用于服务端"选区外严格不变"的合成保真 */
  region?:
    | { x: number; y: number; w: number; h: number }
    | Array<{ x: number; y: number; w: number; h: number }>
  /** 'transparent' = 本地透明化（免费，不消耗上游） */
  mode?: string
}

export interface TaskListQuery extends PageQuery {
  canvas_id?: string
  session_id?: string
  status?: string
}

export const generateApi = {
  image: (payload: GenerateImagePayload, idempotencyKey?: string) =>
    api.post<GenerationTask>('/generate/image', payload, { idempotencyKey }),

  edit: (payload: GenerateEditPayload, idempotencyKey?: string) => {
    const form = new FormData()
    form.append('prompt', payload.prompt)
    if (payload.model) form.append('model', payload.model)
    if (payload.size) form.append('size', payload.size)
    if (payload.base_asset_id) form.append('base_asset_id', payload.base_asset_id)
    if (payload.session_id) form.append('session_id', payload.session_id)
    if (payload.canvas_id) form.append('canvas_id', payload.canvas_id)
    if (payload.file) form.append('file', payload.file)
    if (payload.mask) form.append('mask', payload.mask)
    if (payload.region) form.append('region', JSON.stringify(payload.region))
    if (payload.mode) form.append('edit_mode', payload.mode)
    return api.post<GenerationTask>('/generate/edit', form, { idempotencyKey })
  },

  listTasks: (query: TaskListQuery = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.canvas_id) params.set('canvas_id', query.canvas_id)
    if (query.session_id) params.set('session_id', query.session_id)
    if (query.status) params.set('status', query.status)
    return api.get<PageData<GenerationTask>>(`/generate/tasks?${params.toString()}`)
  },

  getTask: (id: string) => api.get<GenerationTask>(`/generate/tasks/${id}`),
  pause: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/pause`),
  resume: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/resume`),
  cancel: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/cancel`),
  markSeen: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/seen`),
}
