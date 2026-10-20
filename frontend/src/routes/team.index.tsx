import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Coins, Loader2, Plus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/hooks/use-toast'
import { teamsApi, type TeamUsage } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'

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
    <div className="flex flex-col gap-4 p-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <CardDescription className="text-[11px] uppercase tracking-[0.08em]">
            {t('overview.seats')}
          </CardDescription>
          <p className="mt-1 text-h2 font-semibold tabular-nums text-text">
            {t('overview.seats_value', {
              used: team.seat_used,
              total: team.seat_limit,
            })}
          </p>
        </Card>

        <Card className="p-4">
          <CardDescription className="text-[11px] uppercase tracking-[0.08em]">
            {t('overview.balance')}
          </CardDescription>
          <p className="mt-1 flex items-baseline gap-2 text-h2 font-semibold tabular-nums text-text">
            {loading && !usage ? (
              <Loader2 size={16} className="animate-spin text-text-tertiary" />
            ) : (
              (usage?.balance ?? team.balance ?? 0)
            )}
            {team.shared_quota && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent-ink">
                shared
              </span>
            )}
          </p>
        </Card>

        <Card className="p-4">
          <CardDescription className="text-[11px] uppercase tracking-[0.08em]">
            {t('overview.tasks_today')}
          </CardDescription>
          <p className="mt-1 text-h2 font-semibold tabular-nums text-text">
            {usage?.tasks_today ?? 0}
          </p>
        </Card>

        <Card className="p-4">
          <CardDescription className="text-[11px] uppercase tracking-[0.08em]">
            {t('overview.spend_today')}
          </CardDescription>
          <p className="mt-1 text-h2 font-semibold tabular-nums text-text">
            {usage?.spend_today ?? 0}
          </p>
        </Card>
      </div>

      {/* 共享额度未启用：给出「为什么成员还在扣自己的钱」的解释与开关 */}
      {!team.shared_quota && isOwner && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-dashed p-4">
          <div className="flex items-start gap-2">
            <Coins size={16} className="mt-0.5 text-text-tertiary" />
            <CardDescription>{t('overview.shared_off')}</CardDescription>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void enableShared()}>
            {t('overview.enable_shared')}
          </Button>
        </Card>
      )}

      <Card className="p-0">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <CardTitle className="text-ui">{t('overview.members_today')}</CardTitle>
          {canTopup && team.shared_quota && (
            <Button size="sm" variant="secondary" loading={topping} onClick={() => void topup()}>
              <Plus size={14} /> {t('overview.topup')}
            </Button>
          )}
        </div>
        {!usage?.members_today?.length ? (
          <p className="px-4 py-8 text-center text-caption text-text-tertiary">
            {t('overview.no_usage')}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {usage.members_today.map((row) => (
              <li
                key={row.user_id}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-ui"
              >
                <span className="truncate text-text">{row.email || row.user_id}</span>
                <span className="flex shrink-0 items-center gap-4 text-caption text-text-secondary tabular-nums">
                  <span>{row.tasks}</span>
                  <span className="text-text-tertiary">{row.cost}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
