import { create } from 'zustand'
import { authApi } from '@/lib/api/auth'
import { getToken, setToken } from '@/lib/api/client'
import { events } from '@/lib/events'
import type { User } from '@/types/models'

interface AuthState {
  user: User | null
  token: string | null
  initialized: boolean
  loading: boolean
  setSession: (token: string, user: User) => void
  setUser: (user: User) => void
  clear: () => void
  init: () => Promise<void>
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: getToken(),
  initialized: false,
  loading: false,

  setSession: (token, user) => {
    setToken(token)
    set({ token, user, initialized: true })
  },

  setUser: (user) => set({ user }),

  clear: () => {
    setToken(null)
    set({ token: null, user: null })
  },

  init: async () => {
    const token = getToken()
    if (!token) {
      set({ initialized: true, user: null, token: null })
      return
    }
    set({ loading: true, token })
    try {
      const user = await authApi.me()
      set({ user, initialized: true, loading: false })
    } catch {
      setToken(null)
      set({ user: null, token: null, initialized: true, loading: false })
    }
  },

  refresh: async () => {
    if (!get().token) return
    try {
      const user = await authApi.me()
      set({ user })
    } catch {
      /* ignore */
    }
  },

  logout: async () => {
    try {
      await authApi.logout()
    } finally {
      get().clear()
    }
  },
}))

// 401 时清空登录态
events.on('auth:unauthorized', () => {
  useAuthStore.getState().clear()
})
