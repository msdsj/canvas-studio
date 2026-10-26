import { api, apiUrl } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { Asset } from '@/types/models'

export interface AssetListQuery extends PageQuery {
  kind?: string
  q?: string
  /** all = 我的 + 团队共享；mine = 只看我的；team = 只看团队共享 */
  scope?: 'all' | 'mine' | 'team'
}

export interface PromptPreset {
  id: string
  label: string
  prompt: string
}

export interface PromptPresets {
  /** 编辑任务内置提示词前缀（服务端配置） */
  template: string
  /** 常用提示词预设 */
  presets: PromptPreset[]
}

export const assetsApi = {
  list: (query: AssetListQuery = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.kind) params.set('kind', query.kind)
    if (query.q) params.set('q', query.q)
    if (query.scope && query.scope !== 'all') params.set('scope', query.scope)
    return api.get<PageData<Asset>>(`/assets?${params.toString()}`)
  },
  /** 上传图片；`prompt` 为上传流程内置提示词配置（随资产保存，编辑时自动回填）。 */
  upload: (file: File, prompt = '', shareWithTeam = false) => {
    const form = new FormData()
    form.append('file', file)
    if (prompt) form.append('prompt', prompt)
    if (shareWithTeam) form.append('share_with_team', 'true')
    return api.post<Asset>('/assets/upload', form)
  },
  /** 把资产设为团队共享 / 收回私有 */
  setVisibility: (ids: string[], visibility: 'private' | 'team') =>
    api.post<{ updated: number }>('/assets/visibility', { ids, visibility }),
  /** 内置提示词配置（前缀模板 + 常用预设）。 */
  promptPresets: () => api.get<PromptPresets>('/assets/prompt-presets'),
  get: (id: string) => api.get<Asset>(`/assets/${id}`),
  /**
   * 按图片 URL 反查已登记资产（未命中返回 null）。
   *
   * 生成结果早就在服务端登记过资产了，落画布时用它可以省掉
   * 「整张图下载到浏览器 → 再上传回服务端」这一整趟往返。
   */
  byUrl: (url: string) =>
    api.get<Asset | null>(`/assets/by-url?url=${encodeURIComponent(url)}`),
  remove: (id: string) => api.del<unknown>(`/assets/${id}`),
  /** 批量删除（「全选」后用），后端一次软删 */
  removeMany: (ids: string[]) => api.post<{ deleted: number }>('/assets/batch-delete', { ids }),
  downloadUrl: (id: string) => apiUrl(`/assets/${id}/download`),
}
