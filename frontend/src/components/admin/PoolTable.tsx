import { useTranslation } from 'react-i18next'
import { Power, Trash2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { PoolStatusBadge } from './PoolStatusBadge'
import type { PoolAccount } from '@/types/models'

interface PoolTableProps {
  accounts: PoolAccount[]
  loading?: boolean
  selected: string[]
  onToggle: (token: string) => void
  onToggleAll: () => void
  onDelete: (token: string) => void
  onToggleStatus: (account: PoolAccount) => void
}

/** 账号表（掩码 / 类型 / 状态徽章 / 额度 / 最后刷新 / 操作）。 */
export function PoolTable({
  accounts,
  loading,
  selected,
  onToggle,
  onToggleAll,
  onDelete,
  onToggleStatus,
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

  const allSelected = accounts.length > 0 && selected.length === accounts.length

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox checked={allSelected} onCheckedChange={onToggleAll} aria-label="select all" />
          </TableHead>
          <TableHead>{t('pool.token')}</TableHead>
          <TableHead>{t('pool.type')}</TableHead>
          <TableHead>{t('pool.status_filter')}</TableHead>
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
                aria-label="select"
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
                <Button size="icon-sm" variant="ghost" aria-label="toggle" onClick={() => onToggleStatus(account)}>
                  <Power size={15} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('pool.delete')}
                  onClick={() => onDelete(account.id)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
