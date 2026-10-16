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
  display_name?: string
  invite_code?: string
}

export interface RegisterResult {
  user_id: string
  email: string
  status: string
}

export const authApi = {
  register: (payload: RegisterPayload) => api.post<RegisterResult>('/auth/register', payload),
  verifyEmail: (token: string) => api.post<{ status: string }>('/auth/verify-email', { token }),
  resendVerification: (email: string) => api.post<unknown>('/auth/resend-verification', { email }),
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
