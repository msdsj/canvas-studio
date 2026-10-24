import { useTranslation } from 'react-i18next'
import { RefreshCw, Trash2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { PoolStatusBadge } from './PoolStatusBadge'
import type { PoolAccount } from '@/types/models'

interface PoolTableProps {
  accounts: PoolAccount[]
  loading?: boolean
  selected: string[]
  onToggle: (id: string) => void
  onToggleAll: () => void
  onDelete: (id: string) => void
  onRefresh: (account: PoolAccount) => void
}

/** 账号表（掩码 / 类型 / 状态徽章 / 额度 / 最后刷新 / 操作）。 */
export function PoolTable({
  accounts,
  loading,
  selected,
  onToggle,
  onToggleAll,
  onDelete,
  onRefresh,
}: PoolTableProps) {
  const { t } = useTranslation('admin')

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (accounts.length === 0) return <EmptyState title={t('pool.empty')} />

  const allSelected = accounts.length > 0 && accounts.every((account) => selected.includes(account.id))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              checked={allSelected}
              onCheckedChange={onToggleAll}
              aria-label={t('bulk.selected', { count: accounts.length })}
            />
          </TableHead>
          <TableHead>
            <span className="inline-flex items-center gap-1.5">
              {t('pool.token')}
              <Hint label={t('pool.hint_token')} />
            </span>
          </TableHead>
          <TableHead>{t('pool.type')}</TableHead>
          <TableHead>
            <span className="inline-flex items-center gap-1.5">
              {t('pool.status_filter')}
              <Hint label={t('pool.hint_status')} />
            </span>
          </TableHead>
          <TableHead>{t('pool.quota')}</TableHead>
          <TableHead>{t('pool.last_refresh')}</TableHead>
          <TableHead className="text-right">{t('users.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <TableRow key={account.id}>
            <TableCell>
              <Checkbox
                checked={selected.includes(account.id)}
                onCheckedChange={() => onToggle(account.id)}
                aria-label={account.token_masked}
              />
            </TableCell>
            <TableCell className="font-mono text-sm">{account.token_masked}</TableCell>
            <TableCell>{account.type || '—'}</TableCell>
            <TableCell>
              <PoolStatusBadge status={account.status} />
            </TableCell>
            <TableCell className="font-mono">{account.quota}</TableCell>
            <TableCell className="text-sm text-text-secondary">{account.last_refresh || '—'}</TableCell>
            <TableCell>
              <div className="flex items-center justify-end gap-1">
                <Hint label={t('pool.refresh')}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('pool.refresh')}
                    onClick={() => onRefresh(account)}
                  >
                    <RefreshCw size={15} />
                  </Button>
                </Hint>
                <Hint label={t('pool.delete')}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('pool.delete')}
                    onClick={() => onDelete(account.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </Hint>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
