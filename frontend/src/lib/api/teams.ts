import { api } from './client'

/** 团队成员角色。平台角色（user/pro/admin）与团队角色是**两套独立的东西**：
 *  平台 admin 是运维身份，团队 owner 是这家企业的管理员。 */
export type TeamRole = 'owner' | 'admin' | 'member'
export type TeamMemberStatus = 'active' | 'invited' | 'disabled'

/** 权限键：与后端 `PERMISSION_KEYS` 一一对应。 */
export type TeamPermission =
  | 'team.resource.view'
  | 'canvas.edit.any'
  | 'asset.manage'
  | 'member.manage'
  | 'billing.view'
  | 'quota.adjust'
  | 'model.configure'
  | 'skill.manage'
  | 'audit.view'
  | 'team.delete'

export interface Team {
  id: string
  name: string
  slug: string
  owner_user_id: string
  status: string
  seat_limit: number
  seat_used: number
  plan: string
  role: TeamRole
  shared_quota: boolean
  balance: number
  permissions: TeamPermission[]
  created_at?: string | null
}

export interface TeamMember {
  id: string
  team_id: string
  user_id: string
  email: string
  display_name: string
  role: TeamRole
  status: TeamMemberStatus
  permissions: Record<string, boolean>
  joined_at?: string | null
  last_active_at?: string | null
}

export interface TeamInvitation {
  id: string
  team_id: string
  email: string
  role: TeamRole
  status: string
  token?: string
  note: string
  invited_by: string
  expires_at?: string | null
  created_at?: string | null
}

export interface TeamUsage {
  balance: number
  shared_quota: boolean
  seat_limit: number
  seat_used: number
  tasks_today: number
  tasks_total: number
  spend_today: number
  spend_total: number
  members_today: Array<{
    user_id: string
    email: string
    tasks: number
    cost: number
  }>
  since?: string | null
  now?: string | null
}

/** 团队统一配置的模型（成员只读）。 */
export interface TeamModelConfig {
  configured: boolean
  editable: boolean
  name: string
  kind: string
  base_url: string
  model: string
  key_hint: string
  has_key: boolean
  last_test_ok: boolean | null
  last_test_message: string
  temperature: number
  max_tokens: number
  supports_vision: boolean
}

export interface TeamModelConfigInput {
  name: string
  kind: string
  base_url: string
  api_key: string
  model: string
  temperature?: number
  max_tokens?: number
  supports_vision?: boolean
  clear_api_key?: boolean
}

export interface TeamAuditEntry {
  id: string
  action: string
  actor_email: string
  target_type: string
  target_id?: string | null
  detail: Record<string, unknown>
  created_at?: string | null
}

export const teamsApi = {
  list: () => api.get<{ items: Team[]; active_team_id: string | null }>('/teams'),

  create: (payload: { name: string; seat_limit?: number; shared_quota?: boolean }) =>
    api.post<Team>('/teams', payload),

  detail: (teamId: string) => api.get<Team>(`/teams/${teamId}`),

  update: (
    teamId: string,
    payload: {
      name?: string
      seat_limit?: number
      shared_quota?: boolean
    },
  ) => api.patch<Team>(`/teams/${teamId}`, payload),

  remove: (teamId: string) => api.del<{ deleted: string }>(`/teams/${teamId}`),

  /** 切换当前团队；null = 回到个人空间。 */
  setActive: (teamId: string | null) =>
    api.post<{ active_team_id: string | null }>('/teams/active', { team_id: teamId }),

  members: (teamId: string) => api.get<TeamMember[]>(`/teams/${teamId}/members`),

  updateMember: (
    teamId: string,
    memberId: string,
    payload: { role?: TeamRole; status?: TeamMemberStatus; permissions?: Record<string, boolean> },
  ) => api.patch<TeamMember[]>(`/teams/${teamId}/members/${memberId}`, payload),

  removeMember: (teamId: string, memberId: string) =>
    api.del<{ removed: string }>(`/teams/${teamId}/members/${memberId}`),

  transfer: (teamId: string, memberId: string) =>
    api.post<Team>(`/teams/${teamId}/members/${memberId}/transfer`),

  invitations: (teamId: string) => api.get<TeamInvitation[]>(`/teams/${teamId}/invitations`),

  invite: (teamId: string, payload: { email: string; role?: TeamRole; note?: string }) =>
    api.post<TeamInvitation & { token: string; team_id: string }>(
      `/teams/${teamId}/invitations`,
      payload,
    ),

  revokeInvite: (teamId: string, invitationId: string) =>
    api.del<{ revoked: string }>(`/teams/${teamId}/invitations/${invitationId}`),

  previewInvite: (token: string) =>
    api.get<{ team_name: string; email: string | null; role: TeamRole; inviter: string; expired: boolean }>(
      `/teams/invitations/${token}`,
    ),

  acceptInvite: (token: string) =>
    api.post<{ team_id: string; team_name: string }>(`/teams/invitations/${token}/accept`),

  usage: (teamId: string) => api.get<TeamUsage>(`/teams/${teamId}/usage`),

  topup: (teamId: string, amount: number, note?: string) =>
    api.post<{ balance: number }>(`/teams/${teamId}/quota`, { amount, note }),

  modelConfig: (teamId: string) => api.get<TeamModelConfig>(`/teams/${teamId}/model-config`),

  saveModelConfig: (teamId: string, payload: TeamModelConfigInput) =>
    api.put<TeamModelConfig>(`/teams/${teamId}/model-config`, payload),

  audit: (teamId: string, params?: { page?: number; size?: number }) => {
    const query = new URLSearchParams()
    if (params?.page) query.set('page', String(params.page))
    if (params?.size) query.set('size', String(params.size))
    const suffix = query.toString()
    return api.get<{ items: TeamAuditEntry[]; total: number; page: number; size: number }>(
      `/teams/${teamId}/audit${suffix ? `?${suffix}` : ''}`,
    )
  },

  skills: (teamId: string) =>
    api.get<{ pack_keys: string[]; pack_names: string[]; editable: boolean }>(
      `/skills/team/${teamId}`,
    ),

  setSkills: (teamId: string, packKeys: string[]) =>
    api.put<{ pack_keys: string[]; pack_names: string[] }>(`/skills/team/${teamId}`, {
      pack_keys: packKeys,
    }),
}
