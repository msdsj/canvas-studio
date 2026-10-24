import { api, download } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type {
  AdminUser,
  Announcement,
  AuditLog,
  InviteCode,
  Overview,
  PoolAccount,
  PoolStats,
  ProCode,
  QuotaTransaction,
  SystemConfigItem,
} from '@/types/models'

export type PoolImportMethod = 'token' | 'session' | 'codex_auth' | 'account_json' | 'oauth'

export interface PoolProgress {
  status?: string
  done?: number
  total?: number
  detail?: Record<string, unknown>
}

export interface PoolImportResult {
  added: number
  skipped: number
  refreshed: number
  errors: unknown[]
}

export const adminApi = {
  // 概览
  overview: () => api.get<Overview>('/admin/overview'),

  // 用户
  listUsers: (query: PageQuery & { q?: string; role?: string; status?: string } = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.q) params.set('q', query.q)
    if (query.role) params.set('role', query.role)
    if (query.status) params.set('status', query.status)
    return api.get<PageData<AdminUser>>(`/admin/users?${params.toString()}`)
  },
  getUser: (id: string) => api.get<AdminUser>(`/admin/users/${id}`),
  createUser: (payload: { email: string; password: string; role?: string; display_name?: string; team_name?: string }) =>
    api.post<AdminUser>('/admin/users', payload),
  adjustQuota: (id: string, payload: { mode: 'increase' | 'decrease' | 'set'; amount: number; note: string }) =>
    api.post<{ balance: number; tx: QuotaTransaction }>(`/admin/users/${id}/quota`, payload),
  banUser: (id: string, reason: string) =>
    api.post<AdminUser>(`/admin/users/${id}/ban`, { reason }),
  unbanUser: (id: string) => api.post<AdminUser>(`/admin/users/${id}/unban`),
  resetUserPassword: (id: string) =>
    api.post<{ temp_password: string }>(`/admin/users/${id}/reset-password`),
  resendVerification: (id: string) => api.post<unknown>(`/admin/users/${id}/resend-verification`),
  /** 超管直接开通 Pro：duration_hours=0 表示永久，1/24/168/720 对应小时/天/周/月卡 */
  grantPro: (id: string, durationHours: number) =>
    api.post<{ user: AdminUser; pro_expires_at: string | null; duration_hours: number }>(
      `/admin/users/${id}/pro`,
      { duration_hours: durationHours },
    ),

  // 号池
  poolStats: () => api.get<PoolStats>('/admin/pool/stats'),
  poolAccounts: (query: PageQuery & { status?: string; q?: string } = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.status) params.set('status', query.status)
    if (query.q) params.set('q', query.q)
    return api.get<PageData<PoolAccount>>(`/admin/pool/accounts?${params.toString()}`)
  },
  poolImport: (payload: { method: PoolImportMethod; tokens?: string[]; accounts?: Record<string, unknown>[] }) =>
    api.post<PoolImportResult>('/admin/pool/accounts', payload),
  poolDelete: (tokens: string[]) => api.del<{ removed?: number }>('/admin/pool/accounts', { tokens }),
  poolRefresh: (tokens?: string[]) =>
    api.post<{ job_id: string }>('/admin/pool/accounts/refresh', { tokens: tokens ?? [] }),
  poolRefreshProgress: (jobId: string) =>
    api.get<PoolProgress>(`/admin/pool/accounts/refresh/${jobId}`),
  poolRelogin: (tokens: string[]) =>
    api.post<{ job_id: string }>('/admin/pool/accounts/re-login', { tokens }),
  poolReloginProgress: (jobId: string) =>
    api.get<PoolProgress>(`/admin/pool/accounts/re-login/${jobId}`),
  poolUpdate: (payload: {
    access_token: string
    status?: string
    quota?: number
    type?: string
    proxy?: string
  }) => api.post<unknown>('/admin/pool/accounts/update', payload),
  poolExport: (tokens: string[], format: 'json' | 'zip') =>
    download('/admin/pool/accounts/export', { method: 'POST', body: JSON.stringify({ tokens, format }) }),

  // 系统配置
  getConfig: () => api.get<{ items: SystemConfigItem[] }>('/admin/config'),
  updateConfig: (values: Record<string, unknown>) => api.put<{ updated: string[] }>('/admin/config', values),
  testConfig: (target: 'text' | 'image' | 'llm' | 'pool' | 'proxy') =>
    api.post<{ ok: boolean; latency_ms: number; message: string; error_code?: string }>(
      '/admin/config/test',
      { target }
    ),

  // 邀请码
  listInvites: (query: PageQuery = {}) =>
    api.get<PageData<InviteCode>>(`/admin/invites?page=${query.page ?? 1}&size=${query.size ?? 20}`),
  createInvite: (payload: { max_uses: number; expires_at?: string | null }) =>
    api.post<InviteCode>('/admin/invites', payload),
  updateInvite: (id: string, status: 'active' | 'disabled') =>
    api.patch<InviteCode>(`/admin/invites/${id}`, { status }),
  deleteInvite: (id: string) => api.del<unknown>(`/admin/invites/${id}`),

  // Pro 激活码
  listProCodes: (query: PageQuery & { status?: string } = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.status) params.set('status', query.status)
    return api.get<PageData<ProCode>>(`/admin/pro-codes?${params.toString()}`)
  },
  createProCodes: (payload: {
    count: number
    max_uses: number
    note?: string
    expires_at?: string | null
    duration_hours?: number
  }) => api.post<{ items: ProCode[] }>('/admin/pro-codes', payload),
  updateProCode: (id: string, status: 'active' | 'disabled') =>
    api.patch<ProCode>(`/admin/pro-codes/${id}`, { status }),
  deleteProCode: (id: string) => api.del<unknown>(`/admin/pro-codes/${id}`),

  // 公告
  listAnnouncements: (query: PageQuery = {}) =>
    api.get<PageData<Announcement>>(
      `/admin/announcements?page=${query.page ?? 1}&size=${query.size ?? 20}`
    ),
  createAnnouncement: (payload: { title: string; content: string; level: 'info' | 'warning' }) =>
    api.post<Announcement>('/admin/announcements', payload),
  updateAnnouncement: (
    id: string,
    payload: { status?: string; title?: string; content?: string }
  ) => api.patch<Announcement>(`/admin/announcements/${id}`, payload),
  deleteAnnouncement: (id: string) => api.del<unknown>(`/admin/announcements/${id}`),

  // 日志
  listLogs: (query: PageQuery & { actor?: string; action?: string } = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.actor) params.set('actor', query.actor)
    if (query.action) params.set('action', query.action)
    return api.get<PageData<AuditLog>>(`/admin/logs?${params.toString()}`)
  },
}
