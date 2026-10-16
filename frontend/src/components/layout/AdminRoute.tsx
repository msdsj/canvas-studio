import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'

/** 管理员守卫：非 admin 跳转工作台。 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, initialized, isAdmin } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!initialized) return
    if (!isAuthenticated) void navigate({ to: '/login' })
    else if (!isAdmin) void navigate({ to: '/workspace' })
  }, [initialized, isAuthenticated, isAdmin, navigate])

  if (!initialized || !isAuthenticated || !isAdmin) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-text-tertiary">
        <Loader2 className="animate-spin" />
      </div>
    )
  }
  return <>{children}</>
}
