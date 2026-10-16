import { api } from './client'
import type { Announcement } from '@/types/models'

export const announcementsApi = {
  listActive: () => api.get<Announcement[]>('/announcements/active'),
}
