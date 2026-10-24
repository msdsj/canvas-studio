import { useTranslation } from 'react-i18next'
import { Crown, KeyRound, MailCheck, ShieldBan, ShieldCheck, Wallet } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { EmptyState } from '@/components/ui/empty-state'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { useFormatters } from '@/i18n/format'
import { formatDateTime } from '@/lib/utils'
import type { AdminUser } from '@/types/models'

interface UserTableProps {
  users: AdminUser[]
  loading?: boolean
  selected: string[]
  onToggleRow: (user: AdminUser) => void
  onToggleAll: () => void
  onAssignQuota: (user: AdminUser) => void
  onGrantPro: (user: AdminUser) => void
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

const ROLE_VARIANT: Record<string, 'brand' | 'outline'> = {
  admin: 'brand',
  pro: 'brand',
  user: 'outline',
}

/** 用户表（搜索/筛选/分页由页面承载，行操作在此）。 */
export function UserTable({
  users,
  loading,
  selected,
  onToggleRow,
  onToggleAll,
  onAssignQuota,
  onGrantPro,
  onBan,
  onUnban,
  onResetPassword,
  onResend,
}: UserTableProps) {
  const { t } = useTranslation('admin')
  const { dateTime } = useFormatters()

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  if (users.length === 0) {
    return (
      <EmptyState
        title={t('users.empty')}
        description={t('users.empty_desc')}
        hints={[t('users.empty_hint_1'), t('users.empty_hint_2')]}
      />
    )
  }

  const allSelected = users.length > 0 && users.every((user) => selected.includes(user.id))

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <Checkbox checked={allSelected} onCheckedChange={onToggleAll} aria-label={t('bulk.selected', { count: users.length })} />
          </TableHead>
          <TableHead>{t('users.email')}</TableHead>
          <TableHead>
            <span className="inline-flex items-center gap-1.5">
              {t('users.role')}
              <Hint label={t('users.hint_role')} />
            </span>
          </TableHead>
          <TableHead className="text-right">
            <span className="inline-flex items-center gap-1.5">
              {t('users.balance')}
              <Hint label={t('users.hint_balance')} />
            </span>
          </TableHead>
          <TableHead>
            <span className="inline-flex items-center gap-1.5">
              {t('users.status')}
              <Hint label={t('users.hint_status')} />
            </span>
          </TableHead>
          <TableHead>{t('users.created_at')}</TableHead>
          <TableHead className="text-right">{t('users.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell>
              <Checkbox
                checked={selected.includes(user.id)}
                onCheckedChange={() => onToggleRow(user)}
                aria-label={user.email}
              />
            </TableCell>
            <TableCell className="max-w-[260px] truncate font-medium text-text">
              {user.email}
            </TableCell>
            <TableCell>
              {/* 角色原来是纯文本，扫一列分不清谁是管理员 */}
              <div className="flex flex-col gap-0.5">
                <Badge variant={ROLE_VARIANT[user.role] ?? 'soft'}>{user.role}</Badge>
                {/* Pro 到期时间：限时卡到期后后端会自动降回 user */}
                {user.role === 'pro' && user.pro_expires_at && (
                  <span className="text-[10px] tabular-nums text-text-tertiary">
                    {formatDateTime(user.pro_expires_at)}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right font-mono tabular-nums text-text">
              {user.balance}
            </TableCell>
            <TableCell>
              <Badge variant={STATUS_VARIANT[user.status] ?? 'soft'} dot>
                {user.status}
              </Badge>
            </TableCell>
            <TableCell className="text-caption tabular-nums text-text-tertiary">
              {user.created_at ? dateTime(new Date(user.created_at)) : '—'}
            </TableCell>
            <TableCell>
              <div className="flex items-center justify-end gap-0.5">
                <Hint label={t('users.assign_quota')}>
                  <Button size="icon-sm" variant="ghost" aria-label={t('users.assign_quota')} onClick={() => onAssignQuota(user)}>
                    <Wallet size={15} />
                  </Button>
                </Hint>
                {user.role !== 'admin' && (
                  <Hint label={t('pro_grant.action')}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('pro_grant.action')}
                      onClick={() => onGrantPro(user)}
                    >
                      <Crown size={15} />
                    </Button>
                  </Hint>
                )}
                <Hint label={t('users.reset_password')}>
                  <Button size="icon-sm" variant="ghost" aria-label={t('users.reset_password')} onClick={() => onResetPassword(user)}>
                    <KeyRound size={15} />
                  </Button>
                </Hint>
                <Hint label={t('users.resend')}>
                  <Button size="icon-sm" variant="ghost" aria-label={t('users.resend')} onClick={() => onResend(user)}>
                    <MailCheck size={15} />
                  </Button>
                </Hint>
                {user.status === 'banned' ? (
                  <Hint label={t('users.unban')}>
                    <Button size="icon-sm" variant="ghost" aria-label={t('users.unban')} onClick={() => onUnban(user)}>
                      <ShieldCheck size={15} />
                    </Button>
                  </Hint>
                ) : (
                  <Hint label={t('users.ban')}>
                    <Button size="icon-sm" variant="ghost" aria-label={t('users.ban')} onClick={() => onBan(user)}>
                      <ShieldBan size={15} />
                    </Button>
                  </Hint>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
