import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '@/lib/api/client'

interface HealthData {
  status: string
  version: string
  demo_mode: string
  maintenance_mode?: boolean
}

/** 维护模式拦截页：仅当后端 health 明确返回维护中才拦截。 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const [maintenance, setMaintenance] = useState(false)

  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const data = await api.get<HealthData>('/health')
        if (active) setMaintenance(Boolean(data.maintenance_mode))
      } catch {
        /* 后端不可达时不拦截，交由各页错误态处理 */
      }
    }
    void check()
    const timer = setInterval(check, 60_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  if (!maintenance) return <>{children}</>
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-bg text-center">
      <h1 className="text-xl font-semibold text-text">系统维护中</h1>
      <p className="text-text-secondary">平台正在维护，请稍后再试。</p>
    </div>
  )
}
