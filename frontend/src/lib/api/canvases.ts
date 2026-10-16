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
}
