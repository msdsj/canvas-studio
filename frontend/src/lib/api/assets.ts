import { api, apiUrl } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { Asset } from '@/types/models'

export interface AssetListQuery extends PageQuery {
  kind?: string
  q?: string
}

export const assetsApi = {
  list: (query: AssetListQuery = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.kind) params.set('kind', query.kind)
    if (query.q) params.set('q', query.q)
    return api.get<PageData<Asset>>(`/assets?${params.toString()}`)
  },
  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return api.post<Asset>('/assets/upload', form)
  },
  get: (id: string) => api.get<Asset>(`/assets/${id}`),
  remove: (id: string) => api.del<unknown>(`/assets/${id}`),
  downloadUrl: (id: string) => apiUrl(`/assets/${id}/download`),
}
