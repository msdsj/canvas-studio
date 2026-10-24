import { useTranslation } from 'react-i18next'
import { Users, UserCheck, CircleCheck, CircleAlert } from 'lucide-react'
import { MetricCard } from './MetricCard'
import type { PoolStats } from '@/types/models'

/** 号池 4 指标卡。 */
export function PoolStatsCards({ stats }: { stats: PoolStats }) {
  const { t } = useTranslation('admin')
  const mode = stats.routing_mode
  const modeLabel =
    mode === 'local'
      ? '调度方式：本地独立路由（每个任务分配不同 Key）'
      : mode === 'upstream'
        ? `调度方式：上游号池（${stats.upstream_healthy ?? 0}/${stats.upstream_total ?? 0} 个健康账号，由上游排队出图）`
        : mode === 'none'
          ? '当前没有可用账号：请导入账号或检查图片上游'
          : ''

  return (
    <div className="flex flex-col gap-2">
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <MetricCard title={t('overview.pool_total')} value={stats.total} icon={Users} tone="brand" />
      <MetricCard title={t('overview.pool_normal')} value={stats.normal} icon={CircleCheck} tone="success" />
      <MetricCard title={t('overview.pool_limited')} value={stats.limited} icon={UserCheck} tone="warning" />
      <MetricCard
        title={t('overview.pool_problem')}
        value={stats.abnormal + stats.disabled}
        icon={CircleAlert}
        tone="danger"
      />
    </div>
    {modeLabel && (
      <p className="text-caption text-text-tertiary">{modeLabel}</p>
    )}
    </div>
  )
}
