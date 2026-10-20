import { api } from './client'

/** 使用场景（引导页的第一屏）。 */
export interface Persona {
  key: string
  name: string
  tagline: string
  description: string
  icon: string
  packs: string[]
  pack_names: string[]
  skill_count: number
  examples: string[]
}

export interface OnboardingState {
  completed: boolean
  persona_key: string
  pack_keys: string[]
  pack_names: string[]
  skill_count: number
  completed_at?: string | null
}

/** 技能包目录条目（不含 items）。 */
export interface SkillPackSummary {
  key: string
  name: string
  description: string
  personas: string[]
  tags: string[]
  category: string
  count: number
  enabled: boolean
}

/** 技能条目：一条可用的提示词骨架。 */
export interface SkillPackItem {
  id: string
  pack_key: string
  title: string
  summary: string
  prompt: string
  sub: string
  aspect: string
  tags: string[]
  when_to_use: string
  negative: string
  slots: string[]
  pitfalls: string[]
}

export interface SkillPackDetail extends Omit<SkillPackSummary, 'enabled'> {
  items: SkillPackItem[]
}

export const onboardingApi = {
  /** 场景目录：注册页也要用，所以不需要登录。 */
  personas: () => api.get<{ items: Persona[]; total: number }>('/onboarding/personas'),

  state: () => api.get<OnboardingState>('/onboarding/state'),

  /** 完成引导（幂等）。可顺带创建团队。 */
  complete: (payload: { persona_key?: string; pack_keys?: string[]; team_name?: string }) =>
    api.post<{
      completed: boolean
      persona_key: string
      pack_keys: string[]
      pack_names: string[]
      team: { id: string; name: string } | null
    }>('/onboarding/complete', payload),
}

export const skillsApi = {
  packs: () => api.get<{ items: SkillPackSummary[]; total: number }>('/skills/packs'),

  pack: (key: string) => api.get<SkillPackDetail>(`/skills/packs/${key}`),

  mine: (params?: { q?: string; limit?: number }) => {
    const query = new URLSearchParams()
    if (params?.q) query.set('q', params.q)
    if (params?.limit) query.set('limit', String(params.limit))
    const suffix = query.toString()
    return api.get<{
      items: SkillPackItem[]
      team_packs: string[]
      personal_packs: string[]
      total: number
    }>(`/skills/mine${suffix ? `?${suffix}` : ''}`)
  },

  setMine: (packKeys: string[]) =>
    api.put<{ pack_keys: string[]; pack_names: string[] }>('/skills/mine', {
      pack_keys: packKeys,
    }),

  toggle: (skillId: string, enabled: boolean) =>
    api.post<{ skill_id: string; enabled: boolean }>('/skills/mine/toggle', {
      skill_id: skillId,
      enabled,
    }),

  search: (q: string, limit = 20) => {
    const query = new URLSearchParams({ q, limit: String(limit) })
    return api.get<{ items: SkillPackItem[]; total: number }>(`/skills/search?${query.toString()}`)
  },
}
