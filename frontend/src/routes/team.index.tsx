import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Activity, Coins, Loader2, Plus, UserRound, Users, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/hooks/use-toast'
import { teamsApi, type TeamUsage } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/team/')({
  component: TeamOverview,
})

/**
 * 团队概览：席位、共享额度、今日用量。
 *
 * 这块的信息密度刻意做高一点——管理员打开团队页，八成是为了回答
 * 「还剩多少额度」「谁在用」这两个问题，不该让他再点两层。
 */
function TeamOverview() {
  const { t } = useTranslation('team')
  const toast = useToast()
  const teams = useTeamStore((s) => s.teams)
  const activeId = useTeamStore((s) => s.activeId)
  const load = useTeamStore((s) => s.load)
  const team = teams.find((item) => item.id === activeId) ?? null

  const [usage, setUsage] = useState<TeamUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [topping, setTopping] = useState(false)

  const fetchUsage = useCallback(async () => {
    if (!team) return
    setLoading(true)
    try {
      setUsage(await teamsApi.usage(team.id))
    } catch (err) {
      // 权限不足（成员看不到账单）不是错误，静默降级即可
      setUsage(null)
      if (import.meta.env.DEV) console.warn('[team] usage', err)
    } finally {
      setLoading(false)
    }
  }, [team])

  useEffect(() => {
    void fetchUsage()
  }, [fetchUsage])

  const enableShared = useCallback(async () => {
    if (!team) return
    try {
      await teamsApi.update(team.id, { shared_quota: true })
      await load(true)
      await fetchUsage()
      toast.success(t('overview.enable_shared'))
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }, [team, load, fetchUsage, toast, t])

  const topup = useCallback(async () => {
    if (!team) return
    setTopping(true)
    try {
      await teamsApi.topup(team.id, 500, '管理员充值')
      await load(true)
      await fetchUsage()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setTopping(false)
    }
  }, [team, load, fetchUsage, toast])

  if (!team) {
    return (
      <EmptyState
        icon={Users}
        title={t('list.empty')}
        description={t('list.empty_hint')}
      />
    )
  }

  const isOwner = team.role === 'owner'
  const canTopup = isOwner || team.permissions?.includes('quota.adjust')

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Users}
          label={t('overview.seats')}
          value={t('overview.seats_value', {
            used: team.seat_used,
            total: team.seat_limit,
          })}
          hint={
            team.seat_used >= team.seat_limit ? t('members.seat_full') : undefined
          }
        />

        <MetricCard
          icon={Coins}
          label={t('overview.balance')}
          value={
            loading && !usage ? (
              <Loader2 size={16} className="animate-spin text-text-tertiary" />
            ) : (
              (usage?.balance ?? team.balance ?? 0)
            )
          }
          badge={
            team.shared_quota ? (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent-ink">
                {t('overview.shared')}
              </span>
            ) : undefined
          }
          accent
        />

        <MetricCard
          icon={Activity}
          label={t('overview.tasks_today')}
          value={usage?.tasks_today ?? 0}
        />

        <MetricCard
          icon={Wallet}
          label={t('overview.spend_today')}
          value={usage?.spend_today ?? 0}
        />
      </div>

      {/* 共享额度未启用：给出「为什么成员还在扣自己的钱」的解释与开关 */}
      {!team.shared_quota && isOwner && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-dashed bg-bg-subtle/40 p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-surface text-text-tertiary ring-1 ring-inset ring-border/70">
              <Coins size={14} />
            </span>
            <CardDescription className="max-w-[62ch]">{t('overview.shared_off')}</CardDescription>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void enableShared()}>
            {t('overview.enable_shared')}
          </Button>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-ui">{t('overview.members_today')}</CardTitle>
            {team.shared_quota && (
              <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] text-text-tertiary">
                {t('overview.shared')}
              </span>
            )}
          </div>
          {canTopup && team.shared_quota && (
            <Button size="sm" variant="secondary" loading={topping} onClick={() => void topup()}>
              <Plus size={14} /> {t('overview.topup')}
            </Button>
          )}
        </div>

        {!usage?.members_today?.length ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-subtle text-text-faint">
              <UserRound size={16} />
            </span>
            <p className="text-caption text-text-tertiary">{t('overview.no_usage')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2 text-[11px] uppercase tracking-[0.06em] text-text-tertiary">
              <span className="flex-1">{t('overview.col_member')}</span>
              <span className="w-16 text-right">{t('overview.col_tasks')}</span>
              <span className="w-20 text-right">{t('overview.col_cost')}</span>
            </div>
            <ul className="divide-y divide-border/50">
              {usage.members_today.map((row) => (
                <li
                  key={row.user_id}
                  className="flex items-center gap-3 px-4 py-2.5 text-ui transition-colors hover:bg-surface-hover/60"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-medium text-accent-ink">
                    {(row.email || row.user_id).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {row.email || row.user_id}
                  </span>
                  <span className="w-16 shrink-0 text-right text-caption tabular-nums text-text-secondary">
                    {row.tasks}
                  </span>
                  <span className="w-20 shrink-0 text-right text-caption tabular-nums text-text-tertiary">
                    {row.cost}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  )
}

/** 概览指标卡：图标做「弱底片」，数值是主角。 */
function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
  badge,
  accent = false,
}: {
  icon: typeof Users
  label: string
  value: ReactNode
  hint?: string
  badge?: ReactNode
  accent?: boolean
}) {
  return (
    <Card
      className={cn(
        'group relative overflow-hidden p-4 transition-[border-color,box-shadow] duration-200 hover:border-border-strong hover:shadow-lift',
        accent && 'bg-[linear-gradient(140deg,var(--color-accent-soft),var(--color-surface)_62%)]',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <CardDescription className="text-[11px] font-medium uppercase tracking-[0.08em]">
          {label}
        </CardDescription>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-surface/80 text-text-tertiary ring-1 ring-inset ring-border/60 transition-colors group-hover:text-accent-ink">
          <Icon size={14} />
        </span>
      </div>
      <p className="mt-1.5 flex items-baseline gap-2 text-[26px] font-semibold leading-tight tabular-nums text-text">
        {value}
        {badge}
      </p>
      {hint && <p className="mt-1 text-[11px] text-danger">{hint}</p>}
    </Card>
  )
}
