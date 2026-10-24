import { api, apiUrl } from './client'
import type { Canvas, CanvasState } from '@/types/models'

export const canvasesApi = {
  get: (id: string) => api.get<Canvas>(`/canvases/${id}`),
  update: (id: string, payload: { name?: string; state?: CanvasState; thumbnail?: string }) =>
    api.patch<{ updated_at: string }>(`/canvases/${id}`, payload),
  remove: (id: string) => api.del<unknown>(`/canvases/${id}`),
  share: (id: string) => api.post<{ share_token: string; url: string }>(`/canvases/${id}/share`),
  unshare: (id: string) => api.del<unknown>(`/canvases/${id}/share`),
  exportUrl: (id: string, format: 'png' | 'json') =>
    apiUrl(`/canvases/${id}/export?format=${format}`),
  getShared: (token: string) =>
    api.get<{ id: string; name: string; state: CanvasState; thumbnail_url?: string }>(
      `/share/${token}`
    ),

  // ---- 对话分享：整段对话（消息 + 提示词 + 画布快照）----
  shareSession: (sessionId: string) =>
    api.post<{ share_token: string; url: string }>(`/chat/sessions/${sessionId}/share`),
  unshareSession: (sessionId: string) => api.del<unknown>(`/chat/sessions/${sessionId}/share`),
  /** 会话分享状态：刷新后仍能显示链接与「关闭分享」 */
  getSessionShare: (sessionId: string) =>
    api.get<{ shared: boolean; url: string }>(`/chat/sessions/${sessionId}/share`),
  getSharedChat: (token: string) =>
    api.get<SharedChat>(`/share/chat/${token}`),
  /** 「基于它继续创作」：复制一份到我的账号下 */
  forkSharedChat: (token: string) =>
    api.post<{ session_id: string; canvas_id: string | null }>(`/share/chat/${token}/fork`),

  // ---- 协作增强：打点评论 ----
  listComments: (canvasId: string) =>
    api.get<{ items: CanvasComment[]; total: number; unresolved: number }>(
      `/canvases/${canvasId}/comments`
    ),
  createComment: (
    canvasId: string,
    payload: {
      content: string
      x: number
      y: number
      element_id?: string | null
      parent_id?: string | null
      mentions?: string[]
    }
  ) => api.post<CanvasComment>(`/canvases/${canvasId}/comments`, payload),
  updateComment: (commentId: string, payload: { content?: string; resolved?: boolean }) =>
    api.patch<CanvasComment>(`/canvas-comments/${commentId}`, payload),
  deleteComment: (commentId: string) => api.del<unknown>(`/canvas-comments/${commentId}`),

  // ---- 协作增强：版本历史 ----
  listVersions: (canvasId: string) =>
    api.get<{ items: CanvasVersion[] }>(`/canvases/${canvasId}/versions`),
  createVersion: (canvasId: string, label: string) =>
    api.post<CanvasVersion>(`/canvases/${canvasId}/versions`, { label }),
  getVersion: (canvasId: string, versionId: string) =>
    api.get<CanvasVersion & { state: CanvasState }>(`/canvases/${canvasId}/versions/${versionId}`),
  restoreVersion: (canvasId: string, versionId: string) =>
    api.post<{ version: number; snapshot_id: string }>(
      `/canvases/${canvasId}/versions/${versionId}/restore`
    ),
}

/** 一条画布评论（坐标是画布坐标系）。 */
export interface CanvasComment {
  id: string
  canvas_id: string
  x: number
  y: number
  element_id?: string | null
  parent_id?: string | null
  content: string
  mentions: Array<{ id: string; name: string }>
  resolved: boolean
  author: { id: string; name: string; avatar?: string }
  created_at: string
  updated_at: string
}

/** 一个历史版本（不含 state）。 */
export interface CanvasVersion {
  id: string
  label: string
  kind: 'auto' | 'manual' | 'restore'
  version: number
  element_count: number
  author: string
  created_at: string
}

/** 分享出去的对话视图（公开只读）。 */
export interface SharedChatMessage {
  id: string
  role: string
  content: string
  attachments?: unknown
  created_at?: string
  /** 这一轮的最终提示词（被分享者最想拿走的东西） */
  prompt?: string
  /** 这一轮画出来的图（公开只读，来自成功任务的 result_urls） */
  images?: string[]
}

export interface SharedChat {
  session_id: string
  title: string
  updated_at?: string | null
  messages: SharedChatMessage[]
  canvas: {
    id: string
    name: string
    state: CanvasState
    thumbnail_url?: string
    updated_at?: string | null
  } | null
}
