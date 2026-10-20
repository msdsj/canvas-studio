import { useEffect } from 'react'
import { useAuthStore } from '@/stores/auth'
import { useTeamStore } from '@/stores/team'

/** 读取登录态与守卫辅助。 */
export function useAuth() {
  const user = useAuthStore((s) => s.user)
  const token = useAuthStore((s) => s.token)
  const initialized = useAuthStore((s) => s.initialized)
  const loading = useAuthStore((s) => s.loading)
  const logout = useAuthStore((s) => s.logout)
  const teams = useTeamStore((s) => s.teams)
  const activeTeamId = useTeamStore((s) => s.activeId)

  const isAdmin = user?.role === 'admin'
  /**
   * 是否已解锁全部功能：平台 Pro / 管理员，**或者属于任意一个团队**。
   *
   * 团队成员自动获得 Pro 能力是产品决策：企业已经按席位付过钱，
   * 再让员工自己买一次 Pro 会让「开个团队」变成负体验。
   * 判定用「属于某个团队」而不是「当前在团队空间」——否则切回个人空间就掉权限，
   * 用户会以为账号出问题了。
   */
  const isTeamMember = teams.length > 0
  const isPro = user?.role === 'pro' || isAdmin || isTeamMember

  const activeTeam = teams.find((team) => team.id === activeTeamId) ?? null

  return {
    user,
    token,
    initialized,
    loading,
    isAuthenticated: Boolean(user),
    isAdmin,
    isPro,
    /** 平台 Pro（不含团队带来的能力），用于区分「自己买的」和「公司给的」 */
    isPlatformPro: user?.role === 'pro' || isAdmin,
    isTeamMember,
    activeTeam,
    /** 当前是否在团队空间里（个人空间为 false） */
    inTeamSpace: activeTeam !== null,
    logout,
  }
}

/**
 * 登录后把团队列表拉起来（`isPro` 依赖它，所以必须尽早执行）。
 *
 * 挂在根组件上调用一次即可；未登录时不做任何事，登出时清空。
 */
export function useTeamBootstrap(): void {
  const userId = useAuthStore((s) => s.user?.id)
  const load = useTeamStore((s) => s.load)
  const reset = useTeamStore((s) => s.reset)

  useEffect(() => {
    if (!userId) {
      reset()
      return
    }
    void load(true)
  }, [userId, load, reset])
}
