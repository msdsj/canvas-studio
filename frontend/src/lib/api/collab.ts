import { api } from './client'

/** 协作票据：WS 连不上时前端要能优雅退化成「整场景自动保存」。 */
export interface CollabTicket {
  ticket: string
  canvas_id: string
  version: number
  can_write: boolean
  ws_path: string
}

export interface CollabParticipant {
  id: string
  user_id: string
  name: string
  color: string
  cursor: { x: number; y: number } | null
  selection: string[]
  can_write: boolean
}

/** 一次增量修改（元素级）。 */
export interface CanvasPatch {
  added?: Array<Record<string, unknown>>
  updated?: Array<Record<string, unknown>>
  deleted?: string[]
  app_state?: Record<string, unknown>
}

export const collabApi = {
  ticket: (canvasId: string) => api.post<CollabTicket>(`/collab/${canvasId}/ticket`),

  participants: (canvasId: string) =>
    api.get<{ canvas_id: string; count: number; participants: CollabParticipant[] }>(
      `/collab/${canvasId}/participants`,
    ),
}
