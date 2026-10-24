import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Image as ImageIcon, Server, UserCheck, Users, Wallet } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { MetricCard } from '@/components/admin/MetricCard'
import {
  OverviewPending,
  OverviewRecent,
  OverviewTrend,
} from '@/components/admin/OverviewPanels'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { Overview } from '@/types/models'

export const Route = createFileRoute('/admin/')({
  component: AdminOverviewPage,
})

/**
 * 后台概览。
 *
 * v3 改动：
 * 1. **去掉重复的「号池正常」**（改造前它在第一行第 4 张、第二行第 2 张各出现一次）；
 * 2. 指标卡下面补 **14 天趋势图**（新增用户 / 生成量 / 消耗积分）——
 *    原来 8 张数字卡之后整页空白，管理员看不到任何"现在发生了什么"；
 * 3. 补 **待处理** 与 **最近动态** 两个区块。
 *
 * 数据一次请求拿全：`GET /api/admin/overview` 已把 series / recent / pending 并进同一响应。
 */
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

  const pool = overview?.pool
  const spark = (key: 'users_new' | 'images' | 'quota') =>
    (overview?.series ?? []).slice(-7).map((point) => point[key])

  return (
    <AdminShell title={t('sidebar.overview')} description={t('overview.description')}>
      <div className="flex flex-col gap-[var(--gap-dense)]">
        <div className="grid gap-[var(--gap-dense)] sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            title={t('overview.users_total')}
            value={overview?.users_total ?? '—'}
            icon={Users}
            tone="brand"
            spark={spark('users_new')}
          />
          <MetricCard
            title={t('overview.users_active')}
            value={overview?.users_active ?? '—'}
            icon={UserCheck}
            tone="success"
          />
          <MetricCard
            title={t('overview.quota_consumed_today')}
            value={overview?.quota_consumed_today ?? '—'}
            icon={Wallet}
            tone="warning"
            spark={spark('quota')}
          />
          <MetricCard
            title={t('overview.pool_normal')}
            value={`${pool?.normal ?? 0}/${pool?.total ?? 0}`}
            subtitle={t('overview.pool_available')}
            icon={Server}
            tone="neutral"
          />
        </div>

        <div className="grid gap-[var(--gap-dense)] xl:grid-cols-3">
          <div className="xl:col-span-2">
            <OverviewTrend overview={overview} />
          </div>
          <OverviewPending overview={overview} />
        </div>

        <div className="grid gap-[var(--gap-dense)] xl:grid-cols-3">
          <div className="xl:col-span-2">
            <OverviewRecent overview={overview} />
          </div>
          <MetricCard
            title={t('overview.images_total')}
            value={overview?.series?.reduce((sum, point) => sum + point.images, 0) ?? '—'}
            subtitle={t('overview.images_hint')}
            icon={ImageIcon}
            tone="brand"
            spark={spark('images')}
          />
        </div>
      </div>
    </AdminShell>
  )
}
