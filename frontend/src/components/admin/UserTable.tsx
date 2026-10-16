import { useTranslation } from 'react-i18next'
import { KeyRound, MailCheck, ShieldBan, ShieldCheck, Wallet } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/utils'
import type { AdminUser } from '@/types/models'

interface UserTableProps {
  users: AdminUser[]
  loading?: boolean
  onAssignQuota: (user: AdminUser) => void
  onBan: (user: AdminUser) => void
  onUnban: (user: AdminUser) => void
  onResetPassword: (user: AdminUser) => void
  onResend: (user: AdminUser) => void
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'danger'> = {
  active: 'success',
  pending_verification: 'warning',
  banned: 'danger',
}

/** 用户表（搜索/筛选/分页由页面承载，行操作在此）。 */
export function UserTable({ users, loading, onAssignQuota, onBan, onUnban, onResetPassword, onResend }: UserTableProps) {
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

  if (users.length === 0) return <EmptyState title={t('users.empty')} />

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('common:auth.login.email')}</TableHead>
          <TableHead>{t('users.role')}</TableHead>
          <TableHead>{t('users.balance')}</TableHead>
          <TableHead>{t('users.status')}</TableHead>
          <TableHead>{t('users.created_at')}</TableHead>
          <TableHead className="text-right">{t('users.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="max-w-[220px] truncate">{user.email}</TableCell>
            <TableCell>{user.role}</TableCell>
            <TableCell className="font-mono">{user.balance}</TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[user.status] ?? 'soft'} dot>
                {user.status}
              </Badge>
            </TableCell>
            <TableCell className="text-sm text-text-secondary">{formatDateTime(user.created_at)}</TableCell>
            <TableCell>
              <div className="flex items-center justify-end gap-1">
                <Button size="icon-sm" variant="ghost" aria-label={t('users.assign_quota')} onClick={() => onAssignQuota(user)}>
                  <Wallet size={15} />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={t('users.reset_password')} onClick={() => onResetPassword(user)}>
                  <KeyRound size={15} />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={t('users.resend')} onClick={() => onResend(user)}>
                  <MailCheck size={15} />
                </Button>
                {user.status === 'banned' ? (
                  <Button size="icon-sm" variant="ghost" aria-label={t('users.unban')} onClick={() => onUnban(user)}>
                    <ShieldCheck size={15} />
                  </Button>
                ) : (
                  <Button size="icon-sm" variant="ghost" aria-label={t('users.ban')} onClick={() => onBan(user)}>
                    <ShieldBan size={15} />
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
