import { useTranslation } from 'react-i18next'
import { Users, UserCheck, CircleCheck, CircleAlert } from 'lucide-react'
import { MetricCard } from './MetricCard'
import type { PoolStats } from '@/types/models'

/** 号池 4 指标卡。 */
export function PoolStatsCards({ stats }: { stats: PoolStats }) {
  const { t } = useTranslation('admin')
  return (
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
  )
}
