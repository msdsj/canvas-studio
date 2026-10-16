import { useAuthStore } from '@/stores/auth'

/** 读取登录态与守卫辅助。 */
export function useAuth() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const initialized = useAuthStore((s) => s.initialized)
  const loading = useAuthStore((s) => s.loading)
  const logout = useAuthStore((s) => s.logout)

  return {
    user,
    token,
    initialized,
    loading,
    isAuthenticated: Boolean(user),
    isAdmin: user?.role === 'admin',
    logout,
  }
}
