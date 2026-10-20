import { create } from 'zustand'
import { teamsApi, type Team, type TeamRole } from '@/lib/api/teams'

/**
 * 团队状态。
 *
 * 为什么单独一个 store，而不是塞进 auth：团队是「可切换的工作空间」，
 * 切换它会让画布、项目、素材的可见范围整体换一套，跟登录态不是一个生命周期。
 * 但如果放在组件里用 useState，切换团队时十几个组件各自去拉一遍列表，
 * 后端会被打成筛子——所以集中在这里，切换后统一广播刷新。
 */
interface TeamState {
  teams: Team[]
  activeId: string | null
  loading: boolean
  loaded: boolean
  /** 拉取团队列表（幂等：已加载过就不重复请求，除非 force） */
  load: (force?: boolean) => Promise<void>
  /** 切换当前团队；null = 个人空间 */
  switchTo: (teamId: string | null) => Promise<void>
  /** 清空（登出时） */
  reset: () => void
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  activeId: null,
  loading: false,
  loaded: false,

  load: async (force = false) => {
    if (get().loading) return
    if (get().loaded && !force) return
    set({ loading: true })
    try {
      const data = await teamsApi.list()
      set({
        teams: data.items,
        activeId: data.active_team_id ?? null,
        loaded: true,
        loading: false,
      })
    } catch {
      // 拉不到团队不是致命问题：个人空间用法照旧，静默降级
      set({ loading: false, loaded: true })
    }
  },

  switchTo: async (teamId) => {
    await teamsApi.setActive(teamId)
    set({ activeId: teamId })
    // 切换后重新拉一次：seat_used / role 这类字段会随当前团队变化
    set({ loaded: false })
    await get().load(true)
    // 广播给其他模块（项目列表、素材库、画布）自己去重拉
    window.dispatchEvent(new CustomEvent('cs:team-changed', { detail: { teamId } }))
  },

  reset: () => set({ teams: [], activeId: null, loaded: false, loading: false }),
}))

/** 当前团队对象（未在团队里则为 null）。 */
export function useActiveTeam(): Team | null {
  return useTeamStore((s) => s.teams.find((team) => team.id === s.activeId) ?? null)
}

/** 当前团队角色（个人空间为 null）。 */
export function useTeamRole(): TeamRole | null {
  return useActiveTeam()?.role ?? null
}

/** 是否拥有某个团队权限。个人空间下永远 false（团队权限在团队外没有意义）。 */
export function useTeamPermission(permission: string): boolean {
  const team = useActiveTeam()
  if (!team) return false
  return team.permissions?.includes(permission as never) ?? false
}
