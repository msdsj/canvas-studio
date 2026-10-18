import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Pagination } from '@/components/ui/pagination'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { quotaApi } from '@/lib/api/quota'
import { formatDateTime } from '@/lib/utils'
import { errorMessage } from '@/lib/errors'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import type { QuotaTransaction } from '@/types/models'

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

function UsagePage() {
  const { t } = useTranslation('usage')
  const { t: te } = useTranslation()
  const toast = useToast()
  const { balance, totalGranted, thresholdPct, prices } = useQuota()

  const [items, setItems] = useState<QuotaTransaction[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await quotaApi.transactions({ page, size })
      setItems(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <ProtectedRoute>
      <AppShell>
          <PageShell
            title={t('title')}
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <p className="text-sm text-text-secondary">{t('current_balance')}</p>
                <p className="mt-2 text-2xl font-bold text-brand">{balance}</p>
              </Card>
              <Card>
                <p className="text-sm text-text-secondary">{t('total_granted')}</p>
                <p className="mt-2 text-2xl font-bold text-text">{totalGranted}</p>
              </Card>
              <Card>
                <p className="text-sm text-text-secondary">{t('threshold')}</p>
                <p className="mt-2 text-2xl font-bold text-warning">{thresholdPct}%</p>
              </Card>
            </div>

            <Card className="mt-4">
              <h2 className="mb-3 text-md font-semibold text-text">{t('prices.title')}</h2>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <PriceRow label={t('prices.image_standard')} value={prices.image_standard} />
                <PriceRow label={t('prices.image_hd')} value={prices.image_hd} />
                <PriceRow label={t('prices.edit')} value={prices.edit} />
                <PriceRow label={t('prices.chat')} value={prices.chat} />
              </div>
            </Card>

            <h2 className="mb-3 mt-6 text-md font-semibold text-text">{t('transactions.title')}</h2>
            {!loading && items.length === 0 ? (
              <EmptyState title={t('transactions.empty')} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('transactions.type')}</TableHead>
                    <TableHead>{t('transactions.amount')}</TableHead>
                    <TableHead>{t('transactions.balance_after')}</TableHead>
                    <TableHead>{t('transactions.note')}</TableHead>
                    <TableHead>{t('transactions.time')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((tx) => (
                    <TableRow key={tx.id}>
                      <TableCell>
                        <Badge variant={TX_VARIANT[tx.type] ?? 'soft'}>{t(`type.${tx.type}`)}</Badge>
                      </TableCell>
                      <TableCell className={tx.amount < 0 ? 'font-mono text-danger' : 'font-mono text-success'}>
                        {tx.amount > 0 ? `+${tx.amount}` : tx.amount}
                      </TableCell>
                      <TableCell className="font-mono">{tx.balance_after}</TableCell>
                      <TableCell className="max-w-[240px] truncate text-text-secondary">{tx.note || '—'}</TableCell>
                      <TableCell className="text-sm text-text-secondary">{formatDateTime(tx.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

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
          </PageShell>
      </AppShell>
    </ProtectedRoute>
  )
}

function PriceRow({ label, value }: { label: string; value: number }) {
  const { t } = useTranslation('common')
  return (
    <div className="rounded-md bg-bg-subtle px-3 py-2">
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className="mt-0.5 font-mono text-text">
        {value} {t('credits', { defaultValue: '积分' })}
      </p>
    </div>
  )
}
