import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ReceiptText, TrendingDown, TrendingUp, Wallet } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/ui/pagination'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableCard,
} from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { LineChart } from '@/components/ui/chart'
import { quotaApi } from '@/lib/api/quota'
import { errorMessage } from '@/lib/errors'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import { useFormatters } from '@/i18n/format'
import type { QuotaSummary, QuotaTransaction } from '@/types/models'

export const Route = createFileRoute('/usage')({
  component: UsagePage,
})

const TX_VARIANT: Record<string, 'brand' | 'soft' | 'success' | 'warning'> = {
  grant: 'success',
  consume_image: 'soft',
  consume_edit: 'soft',
  consume_chat: 'soft',
  admin_adjust: 'brand',
}

const FILTERS = ['all', 'consume_image', 'consume_edit', 'consume_chat', 'grant', 'admin_adjust'] as const

/**
 * 额度中心。
 *
 * v3 改动：
 * 1. **「累计获得」不再是恒为 0 的占位值**——改用 `GET /api/quota/summary` 的真实口径
 *    （流水入账 + 未入账的历史初始余额），与余额并列时不再自相矛盾；
 * 2. 补 **消耗趋势图**（近 14 天）——一个叫"额度中心"的页面没有曲线是说不过去的；
 * 3. 流水表包进卡片、分页吸底、时间走 `useFormatters`（原来硬编码 en-US 格式，与中文界面不一致）。
 */
function UsagePage() {
  const { t } = useTranslation('usage')
  const { t: te } = useTranslation()
  const toast = useToast()
  const { balance, prices } = useQuota()
  const { dateTime } = useFormatters()

  const [summary, setSummary] = useState<QuotaSummary | null>(null)
  const [items, setItems] = useState<QuotaTransaction[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [sum, result] = await Promise.all([
        quotaApi.summary(),
        quotaApi.transactions({
          page,
          size,
          type: filter === 'all' ? undefined : filter,
        }),
      ])
      setSummary(sum)
      setItems(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, filter])

  useEffect(() => {
    void load()
  }, [load])

  const labels = useMemo(
    () => (summary?.series ?? []).map((point) => point.date.slice(5)),
    [summary],
  )
  const consumed = useMemo(
    () => (summary?.series ?? []).map((point) => point.consumed),
    [summary],
  )
  const granted = useMemo(
    () => (summary?.series ?? []).map((point) => point.granted),
    [summary],
  )
  const todayConsumed = summary?.series?.[summary.series.length - 1]?.consumed ?? 0

  return (
    <ProtectedRoute>
      <AppShell>
        <PageShell title={t('title')} description={t('subtitle')}>
          <div className="flex flex-col gap-[var(--gap-normal)]">
            <div className="grid gap-[var(--gap-dense)] sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label={t('current_balance')}
                value={summary?.balance ?? balance}
                icon={Wallet}
                tone="text-text"
              />
              <StatCard
                label={t('total_granted')}
                value={summary?.total_granted ?? '—'}
                icon={TrendingUp}
                tone="text-success"
              />
              <StatCard
                label={t('total_consumed')}
                value={summary?.total_consumed ?? '—'}
                icon={TrendingDown}
                tone="text-danger"
              />
              <StatCard
                label={t('consumed_today')}
                value={todayConsumed}
                icon={ReceiptText}
                tone="text-warning"
              />
            </div>

            <Card className="flex flex-col gap-4">
              <div className="flex items-baseline justify-between gap-3">
                <div>
                  <h2 className="text-md font-semibold text-text">{t('trend.title')}</h2>
                  <p className="mt-1 text-caption text-text-tertiary">{t('trend.desc')}</p>
                </div>
                <span className="shrink-0 text-caption tabular-nums text-text-tertiary">
                  {t('trend.days', { days: labels.length || 14 })}
                </span>
              </div>
              <LineChart
                series={[
                  { key: 'consumed', label: t('trend.consumed'), values: consumed },
                  { key: 'granted', label: t('trend.granted'), values: granted, color: 'var(--chart-2)' },
                ]}
                labels={labels}
                height={200}
                emptyText={t('trend.empty')}
              />
            </Card>

            <Card className="flex flex-col gap-3">
              <h2 className="text-md font-semibold text-text">{t('prices.title')}</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <PriceRow label={t('prices.image_standard')} value={prices.image_standard} />
                <PriceRow label={t('prices.image_hd')} value={prices.image_hd} />
                <PriceRow label={t('prices.edit')} value={prices.edit} />
                <PriceRow label={t('prices.chat')} value={prices.chat} />
              </div>
            </Card>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-md font-semibold text-text">{t('transactions.title')}</h2>
                <div className="flex flex-wrap items-center gap-1 rounded-full bg-bg-subtle p-1">
                  {FILTERS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        setFilter(key)
                        setPage(1)
                      }}
                      className={
                        filter === key
                          ? 'rounded-full bg-surface px-3 py-1 text-caption font-medium text-text shadow-xs'
                          : 'rounded-full px-3 py-1 text-caption text-text-tertiary transition-colors hover:text-text-secondary'
                      }
                    >
                      {key === 'all' ? t('filter.all') : t(`type.${key}`)}
                    </button>
                  ))}
                </div>
              </div>

              {!loading && items.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={ReceiptText}
                    title={t('transactions.empty')}
                    description={t('transactions.empty_desc')}
                    hints={[t('transactions.hint_1'), t('transactions.hint_2')]}
                    className="min-h-[280px]"
                  />
                </Card>
              ) : (
                <>
                  <TableCard>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t('transactions.type')}</TableHead>
                          <TableHead>{t('transactions.amount')}</TableHead>
                          <TableHead>{t('transactions.balance_after')}</TableHead>
                          <TableHead>{t('transactions.note')}</TableHead>
                          <TableHead className="text-right">{t('transactions.time')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((tx) => (
                          <TableRow key={tx.id}>
                            <TableCell>
                              <Badge variant={TX_VARIANT[tx.type] ?? 'soft'}>
                                {t(`type.${tx.type}`)}
                              </Badge>
                            </TableCell>
                            <TableCell
                              className={
                                tx.amount < 0
                                  ? 'font-mono tabular-nums text-danger'
                                  : 'font-mono tabular-nums text-success'
                              }
                            >
                              {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
                            </TableCell>
                            <TableCell className="font-mono tabular-nums text-text-secondary">
                              {tx.balance_after}
                            </TableCell>
                            <TableCell className="max-w-[240px] truncate text-text-secondary">
                              {tx.note || '—'}
                            </TableCell>
                            <TableCell className="text-right text-caption tabular-nums text-text-tertiary">
                              {tx.created_at ? dateTime(new Date(tx.created_at)) : '—'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableCard>
                  <Pagination
                    page={page}
                    size={size}
                    total={total}
                    onPageChange={setPage}
                    onSizeChange={(s) => {
                      setSize(s)
                      setPage(1)
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </PageShell>
      </AppShell>
    </ProtectedRoute>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: number | string
  icon: typeof Wallet
  tone: string
}) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-text-secondary">{label}</p>
        <Icon size={15} className="shrink-0 text-text-tertiary" />
      </div>
      <p className={`font-mono text-[28px] font-semibold leading-none tabular-nums ${tone}`}>{value}</p>
    </Card>
  )
}

function PriceRow({ label, value }: { label: string; value: number }) {
  const { t } = useTranslation('common')
  return (
    <div className="rounded-[12px] bg-bg-subtle px-3 py-2.5">
      <p className="text-caption text-text-tertiary">{label}</p>
      <p className="mt-1 font-mono tabular-nums text-text">
        {value} {t('credits', { defaultValue: '积分' })}
      </p>
    </div>
  )
}
