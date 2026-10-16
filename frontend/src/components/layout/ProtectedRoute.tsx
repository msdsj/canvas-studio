import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'

function FullScreenLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-bg text-text-tertiary">
      <Loader2 className="animate-spin" />
    </div>
  )
}

/** 登录守卫：未登录跳转 /login。 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, initialized } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (initialized && !isAuthenticated) {
      void navigate({ to: '/login' })
    }
  }, [initialized, isAuthenticated, navigate])

  if (!initialized || !isAuthenticated) return <FullScreenLoader />
  return <>{children}</>
}
