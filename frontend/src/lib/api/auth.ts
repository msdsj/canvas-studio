import { api, setToken } from './client'
import type { User } from '@/types/models'

export interface LoginResult {
  access_token: string
  token_type: string
  user: User
}

export interface RegisterPayload {
  email: string
  password: string
}

/** 注册响应与登录一致：直接带回可用登录态（注册即登录，无邮箱确认环节）。 */
export type RegisterResult = LoginResult

export const authApi = {
  register: (payload: RegisterPayload) => api.post<RegisterResult>('/auth/register', payload),
  /** 兼容历史确认链接落地页（后台代发确认邮件的账号仍可用）。 */
  verifyEmail: (token: string) => api.post<{ status: string }>('/auth/verify-email', { token }),
  login: async (email: string, password: string) => {
    const result = await api.post<LoginResult>('/auth/login', { email, password })
    setToken(result.access_token)
    return result
  },
  logout: async () => {
    try {
      await api.post<unknown>('/auth/logout')
    } finally {
      setToken(null)
    }
  },
  forgotPassword: (email: string) => api.post<unknown>('/auth/forgot-password', { email }),
  resetPassword: (token: string, newPassword: string) =>
    api.post<unknown>('/auth/reset-password', { token, new_password: newPassword }),
  me: () => api.get<User>('/auth/me'),
}
