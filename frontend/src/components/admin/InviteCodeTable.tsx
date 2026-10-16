import { useTranslation } from 'react-i18next'
import { Copy, Power, Trash2 } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/utils'
import type { InviteCode } from '@/types/models'

interface InviteCodeTableProps {
  invites: InviteCode[]
  loading?: boolean
  onToggle: (invite: InviteCode) => void
  onDelete: (invite: InviteCode) => void
  onCopy: (code: string) => void
}

/** 邀请码表（生成 / 禁用 / 统计）。 */
export function InviteCodeTable({ invites, loading, onToggle, onDelete, onCopy }: InviteCodeTableProps) {
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

  return (
    <Table>
      <TableHeader>
        <TableRow>
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
                <Button size="icon-sm" variant="ghost" aria-label={t('invites.copy')} onClick={() => onCopy(invite.code)}>
                  <Copy size={15} />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="toggle" onClick={() => onToggle(invite)}>
                  <Power size={15} />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="delete" onClick={() => onDelete(invite)}>
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
