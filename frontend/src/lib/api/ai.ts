import { api } from './client'

/** 中转站类型（新建表单的预填建议）。 */
export interface ProviderKindPreset {
  id: string
  label: string
  base_url: string
  model: string
  protocol: string
}

/** 一条用户配置的中转站。 */
export interface AIProvider {
  id: string
  name: string
  kind: string
  base_url: string
  model: string
  temperature: number
  max_tokens: number
  extra: Record<string, unknown>
  supports_vision: boolean
  is_active: boolean
  key_hint: string
  has_key: boolean
  last_test_ok: boolean | null
  last_test_at: string | null
  last_test_message: string
  created_at?: string | null
  updated_at?: string | null
}

export interface ProviderUpsert {
  name: string
  kind: string
  base_url: string
  api_key: string
  model: string
  temperature: number
  max_tokens: number
  extra: Record<string, unknown>
  supports_vision: boolean
  is_active?: boolean
  /** 显式清除已保存的 Key（传空字符串有歧义，后端不认） */
  clear_api_key?: boolean
}

export interface RelayStatus {
  configured: boolean
  source: string
  provider_name: string
  model: string
  kind: string
  reason: string
  skills_count: number
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  elapsed_ms: number
  endpoint?: string
  model?: string
}

/** 润色模式：主流设计工具的「润色」都是一组动作，不是一个按钮。 */
export type PolishMode = 'auto' | 'specific' | 'professional' | 'concise' | 'english' | 'fix'

export const POLISH_MODES: Array<{ id: PolishMode; label: string; hint: string }> = [
  // 文案必须体现「保真优先」：润色只补技术参数，不改主体与风格方向
  { id: 'auto', label: '智能', hint: '只补最缺的一点，主体与文字保持原样' },
  { id: 'specific', label: '更具体', hint: '补构图、光线等技术参数，最多两项' },
  { id: 'professional', label: '更专业', hint: '把口语换成设计术语，不增加内容' },
  { id: 'concise', label: '更简洁', hint: '去掉冗余口语，保留全部关键信息' },
  { id: 'english', label: '英文', hint: '翻译成英文提示词，不做扩写' },
  { id: 'fix', label: '修歧义', hint: '只消解矛盾表述，其余原样保留' },
]

export interface PolishVariant {
  id: string
  label: string
  text: string
  notes: string[]
  length: number
}

export interface PolishResult {
  text: string
  variants: PolishVariant[]
  original: string
  mode: string
  engine: 'relay' | 'local'
  model: string
  elapsed_ms: number
}

/** 设计技能的结构化参数（构图/光线/色彩/材质…）。 */
export interface DesignSkill {
  id: string
  name: string
  category: string
  description: string
  when_to_use: string
  prompt_scaffold: string
  negative: string
  aspect: string
  style_tags: string[]
  /** 结构化参数（构图/光线/色彩/材质…），旧后端可能没有 */
  slots?: Record<string, string>
  pitfalls?: string[]
}

export interface DesignSkillCategory {
  id: string
  name: string
  description: string
  count: number
}

export const aiApi = {
  presets: () => api.get<{ kinds: ProviderKindPreset[] }>('/ai/presets'),
  status: () => api.get<RelayStatus>('/ai/status'),
  providers: () => api.get<AIProvider[]>('/ai/providers'),
  createProvider: (payload: ProviderUpsert) => api.post<AIProvider>('/ai/providers', payload),
  updateProvider: (id: string, payload: ProviderUpsert) =>
    api.patch<AIProvider>(`/ai/providers/${id}`, payload),
  deleteProvider: (id: string) => api.del<{ deleted: string }>(`/ai/providers/${id}`),
  activateProvider: (id: string) => api.post<AIProvider>(`/ai/providers/${id}/activate`),
  /** 已保存配置的测试：可带未保存的表单值覆盖。 */
  testProvider: (id: string, draft?: Partial<ProviderUpsert>) =>
    api.post<ProviderTestResult>(`/ai/providers/${id}/test`, draft ?? {}),
  /** 未保存草稿的测试。 */
  testDraft: (draft: Partial<ProviderUpsert>) =>
    api.post<ProviderTestResult>('/ai/providers/test', draft),
  skills: (params?: { category?: string; q?: string }) => {
    const query = new URLSearchParams()
    if (params?.category) query.set('category', params.category)
    if (params?.q) query.set('q', params.q)
    const suffix = query.toString()
    return api.get<{
      items: DesignSkill[]
      total: number
      categories: DesignSkillCategory[]
    }>(`/ai/skills${suffix ? `?${suffix}` : ''}`)
  },
  polish: async (payload: {
    text: string
    scene: 'composer' | 'region' | 'sidebar'
    mode?: PolishMode
    variants?: number
    context?: Record<string, unknown>
  }): Promise<PolishResult> => {
    // 兼容旧后端（只返回 text/notes）：滚动升级时前端不至于因为少一个字段而崩
    const data = await api.post<PolishResult & { notes?: string[] }>('/ai/polish', payload)
    if (!Array.isArray(data.variants) || data.variants.length === 0) {
      return {
        ...data,
        variants: [
          {
            id: 'v1',
            label: '润色',
            text: data.text,
            notes: data.notes ?? [],
            length: data.text.length,
          },
        ],
      }
    }
    return data
  },
}
