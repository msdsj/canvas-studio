import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Users, UserCheck, Wallet, Server } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { MetricCard } from '@/components/admin/MetricCard'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { Overview } from '@/types/models'

export const Route = createFileRoute('/admin/')({
  component: AdminOverviewPage,
})

function AdminOverviewPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()
  const [overview, setOverview] = useState<Overview | null>(null)

  useEffect(() => {
    adminApi
      .overview()
      .then(setOverview)
      .catch((error) => toast.error(errorMessage(error, te)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AdminShell title={t('sidebar.overview')} description={t('title')}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title={t('overview.users_total')} value={overview?.users_total ?? '—'} icon={Users} tone="brand" />
        <MetricCard title={t('overview.users_active')} value={overview?.users_active ?? '—'} icon={UserCheck} tone="success" />
        <MetricCard
          title={t('overview.quota_consumed_today')}
          value={overview?.quota_consumed_today ?? '—'}
          icon={Wallet}
          tone="warning"
        />
        <MetricCard
          title={t('overview.pool_normal')}
          value={`${overview?.pool.normal ?? 0}/${overview?.pool.total ?? 0}`}
          icon={Server}
          tone="neutral"
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title={t('overview.pool_total')} value={overview?.pool.total ?? 0} tone="brand" />
        <MetricCard title={t('overview.pool_normal')} value={overview?.pool.normal ?? 0} tone="success" />
        <MetricCard title={t('overview.pool_limited')} value={overview?.pool.limited ?? 0} tone="warning" />
        <MetricCard
          title={t('overview.pool_problem')}
          value={(overview?.pool.abnormal ?? 0) + (overview?.pool.disabled ?? 0)}
          tone="danger"
        />
      </div>
    </AdminShell>
  )
}
