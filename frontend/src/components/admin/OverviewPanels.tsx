import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Server, TriangleAlert, UserCheck, Users } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { BarChart, LineChart } from '@/components/ui/chart'
import { EmptyState } from '@/components/ui/empty-state'
import type { Overview } from '@/types/models'

/**
 * 后台概览的三个区块：趋势 / 待处理 / 最近动态。
 *
 * 改造前这个页面只有 8 张数字卡（含一张重复的「号池正常」），卡片以下整页空白——
 * 管理员打开后台看不到任何"现在发生了什么"，只能自己去翻日志页。
 */

export function OverviewTrend({ overview }: { overview: Overview | null }) {
  const { t } = useTranslation('admin')
  const series = overview?.series ?? []
  const labels = useMemo(() => series.map((point) => point.date.slice(5)), [series])
  const users = useMemo(() => series.map((point) => point.users_new), [series])
  const images = useMemo(() => series.map((point) => point.images), [series])
  const quota = useMemo(() => series.map((point) => point.quota), [series])

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-md font-semibold text-text">{t('overview.trend_title')}</h2>
          <p className="mt-1 text-caption text-text-tertiary">{t('overview.trend_desc')}</p>
        </div>
        <span className="shrink-0 text-caption tabular-nums text-text-tertiary">
          {t('overview.trend_days', { days: series.length || 14 })}
        </span>
      </div>

      {series.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t('overview.trend_empty_title')}
          description={t('overview.trend_empty_desc')}
          className="min-h-[180px] py-8"
        />
      ) : (
        <>
          <LineChart
            series={[{ key: 'images', label: t('overview.trend_images'), values: images }]}
            labels={labels}
            height={180}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-caption text-text-secondary">{t('overview.trend_users')}</p>
              <BarChart
                series={[{ key: 'users', label: t('overview.trend_users'), values: users }]}
                labels={labels}
                height={96}
              />
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-caption text-text-secondary">{t('overview.trend_quota')}</p>
              <BarChart
                series={[{ key: 'quota', label: t('overview.trend_quota'), values: quota }]}
                labels={labels}
                height={96}
              />
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

export function OverviewPending({ overview }: { overview: Overview | null }) {
  const { t } = useTranslation('admin')
  const pending = overview?.pending
  const items = [
    {
      key: 'users',
      label: t('overview.pending_users'),
      value: pending?.users_pending_verification ?? 0,
      icon: UserCheck,
      tone: 'warning' as const,
      to: '/admin/users',
    },
    {
      key: 'pool_abnormal',
      label: t('overview.pending_pool_abnormal'),
      value: pending?.pool_abnormal ?? 0,
      icon: TriangleAlert,
      tone: 'danger' as const,
      to: '/admin/pool',
    },
    {
      key: 'pool_limited',
      label: t('overview.pending_pool_limited'),
      value: pending?.pool_limited ?? 0,
      icon: Server,
      tone: 'neutral' as const,
      to: '/admin/pool',
    },
  ]
  const total = items.reduce((sum, item) => sum + item.value, 0)

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md font-semibold text-text">{t('overview.pending_title')}</h2>
        {total > 0 && (
          <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-micro font-semibold text-warning">
            {total}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.key}>
              <Link
                to={item.to}
                className="flex items-center gap-3 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-surface-hover"
              >
                <Icon size={16} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-ui text-text-secondary">
                  {item.label}
                </span>
                <span className="font-mono text-caption tabular-nums text-text">{item.value}</span>
                <ArrowUpRight size={14} className="shrink-0 text-text-faint" />
              </Link>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function OverviewRecent({ overview }: { overview: Overview | null }) {
  const { t } = useTranslation('admin')
  const recent = overview?.recent ?? []

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-md font-semibold text-text">{t('overview.recent_title')}</h2>
        <Link
          to="/admin/logs"
          className="shrink-0 text-caption text-text-tertiary transition-colors hover:text-text"
        >
          {t('overview.recent_all')}
        </Link>
      </div>
      {recent.length === 0 ? (
        <p className="py-6 text-center text-caption text-text-tertiary">
          {t('overview.recent_empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {recent.map((item, index) => (
            <li
              key={`${item.at}-${index}`}
              className="flex items-center gap-3 border-b border-border-faint py-2.5 last:border-0"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong"
              />
              <span className="min-w-0 flex-1 truncate text-ui text-text-secondary">{item.text}</span>
              <span className="shrink-0 text-micro tabular-nums text-text-tertiary">
                {new Date(item.at).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
