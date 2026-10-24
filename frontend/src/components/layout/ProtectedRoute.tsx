import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useAuth } from '@/hooks/use-auth'
import { useUIStore } from '@/stores/ui'

function FullScreenLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-border-strong border-t-accent-strong" />
        <span className="text-micro text-text-tertiary">正在打开工作室…</span>
      </div>
    </div>
  )
}

/**
 * 登录守卫：未登录时回到首页并唤起登录弹窗。
 *
 * 不再跳转独立登录页——用户刚刚才在首页输入了需求，把他甩到一个空白的登录页
 * 等于把上下文弄丢。首页 + 弹窗的组合，关掉弹窗就还是原来那一屏。
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, initialized, user } = useAuth()
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const openAuth = useUIStore((s) => s.openAuth)

  useEffect(() => {
    if (initialized && !isAuthenticated) {
      openAuth('login', '登录后即可进入工作室继续创作')
      void navigate({ to: '/' })
    }
  }, [initialized, isAuthenticated, navigate, openAuth])

  /*
   * 首登引导：既没选过场景、也没完成过引导的用户，先带他去选一次。
   *
   * 只卡 `persona_key` 会让「跳过」变成死循环：跳过时不会写 persona_key，
   * 用户点「进入工作台」又被弹回引导页，看起来就是按钮完全没反应。
   * 两个字段任一有值都算「引导已处理」，历史用户（只有完成时间）也不会被漏掉。
   *
   * `/onboarding` 自身也包在 ProtectedRoute 里，必须排除，否则无限重定向。
   */
  const needsOnboarding =
    initialized &&
    isAuthenticated &&
    !user?.persona_key &&
    !user?.onboarding_completed_at &&
    pathname !== '/onboarding'

  useEffect(() => {
    if (needsOnboarding) void navigate({ to: '/onboarding', replace: true })
  }, [needsOnboarding, navigate])

  if (!initialized || !isAuthenticated) return <FullScreenLoader />
  if (needsOnboarding) return <FullScreenLoader />
  return <>{children}</>
}
