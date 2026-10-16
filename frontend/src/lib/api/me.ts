import { api } from './client'
import type { User } from '@/types/models'

export const meApi = {
  getProfile: () => api.get<User>('/me'),
  updateProfile: (payload: { display_name?: string; locale?: string; theme?: string }) =>
    api.patch<User>('/me', payload),
  changePassword: (oldPassword: string, newPassword: string) =>
    api.post<unknown>('/me/change-password', {
      old_password: oldPassword,
      new_password: newPassword,
    }),
  logoutAll: () => api.post<unknown>('/me/logout-all'),
}
