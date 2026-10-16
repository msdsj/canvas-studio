import { api } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { Canvas, CanvasProject } from '@/types/models'

export interface ProjectListQuery extends PageQuery {
  q?: string
}

export const projectsApi = {
  list: (query: ProjectListQuery = {}) =>
    api.get<PageData<CanvasProject>>(
      `/projects?page=${query.page ?? 1}&size=${query.size ?? 20}${
        query.q ? `&q=${encodeURIComponent(query.q)}` : ''
      }`
    ),
  create: (name: string, description?: string) =>
    api.post<CanvasProject>('/projects', { name, description }),
  get: (id: string) => api.get<CanvasProject>(`/projects/${id}`),
  update: (id: string, name: string) => api.patch<CanvasProject>(`/projects/${id}`, { name }),
  remove: (id: string) => api.del<unknown>(`/projects/${id}`),
  listCanvases: (projectId: string) => api.get<Canvas[]>(`/projects/${projectId}/canvases`),
  createCanvas: (projectId: string, name: string) =>
    api.post<Canvas>(`/projects/${projectId}/canvases`, { name }),
}
