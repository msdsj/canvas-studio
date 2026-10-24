import { useTranslation } from 'react-i18next'
import { Copy, Power, Trash2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/utils'
import type { InviteCode } from '@/types/models'

interface InviteCodeTableProps {
  invites: InviteCode[]
  loading?: boolean
  selected: string[]
  onToggleRow: (invite: InviteCode) => void
  onToggleAll: () => void
  onToggle: (invite: InviteCode) => void
  onDelete: (invite: InviteCode) => void
  onCopy: (code: string) => void
}

/** 邀请码表（生成 / 禁用 / 统计）。 */
export function InviteCodeTable({
  invites,
  loading,
  selected,
  onToggleRow,
  onToggleAll,
  onToggle,
  onDelete,
  onCopy,
}: InviteCodeTableProps) {
  const { t } = useTranslation('admin')

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }
  if (invites.length === 0) return <EmptyState title={t('invites.empty')} />

  const allSelected = invites.length > 0 && invites.every((invite) => selected.includes(invite.id))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox checked={allSelected} onCheckedChange={onToggleAll} aria-label={t('bulk.selected', { count: invites.length })} />
          </TableHead>
          <TableHead>{t('invites.code')}</TableHead>
          <TableHead>{t('invites.max_uses')}</TableHead>
          <TableHead>{t('invites.used')}</TableHead>
          <TableHead>{t('invites.status')}</TableHead>
          <TableHead>{t('invites.expires_at')}</TableHead>
          <TableHead className="text-right">{t('users.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invites.map((invite) => (
          <TableRow key={invite.id}>
            <TableCell>
              <Checkbox
                checked={selected.includes(invite.id)}
                onCheckedChange={() => onToggleRow(invite)}
                aria-label={invite.code}
              />
            </TableCell>
            <TableCell className="font-mono">{invite.code}</TableCell>
            <TableCell>{invite.max_uses}</TableCell>
            <TableCell>{invite.used_count}</TableCell>
            <TableCell>
              <Badge variant={invite.status === 'active' ? 'success' : 'soft'} dot>
                {invite.status}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-text-secondary">
              {invite.expires_at ? formatDateTime(invite.expires_at) : '—'}
            </TableCell>
            <TableCell>
              <div className="flex items-center justify-end gap-1">
                <Hint label={t('invites.copy')}>
                  <Button size="icon-sm" variant="ghost" aria-label={t('invites.copy')} onClick={() => onCopy(invite.code)}>
                    <Copy size={15} />
                  </Button>
                </Hint>
                <Hint label={invite.status === 'active' ? t('bulk.disable') : t('bulk.enable')}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={invite.status === 'active' ? t('bulk.disable') : t('bulk.enable')}
                    onClick={() => onToggle(invite)}
                  >
                    <Power size={15} />
                  </Button>
                </Hint>
                <Hint label={t('bulk.delete')}>
                  <Button size="icon-sm" variant="ghost" aria-label={t('bulk.delete')} onClick={() => onDelete(invite)}>
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
