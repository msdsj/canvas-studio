import { useTranslation } from 'react-i18next'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/utils'
import type { AuditLog } from '@/types/models'

interface AuditLogTableProps {
  logs: AuditLog[]
  loading?: boolean
}

/** 审计日志查询表。 */
export function AuditLogTable({ logs, loading }: AuditLogTableProps) {
  const { t } = useTranslation('admin')

  if (loading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }
  if (logs.length === 0) return <EmptyState title={t('logs.empty')} />

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('logs.actor')}</TableHead>
          <TableHead>{t('logs.action')}</TableHead>
          <TableHead>{t('logs.target')}</TableHead>
          <TableHead>{t('logs.time')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => (
          <TableRow key={log.id}>
            <TableCell className="max-w-[200px] truncate">{log.actor_email || '—'}</TableCell>
            <TableCell>
              {/* 原始 action 是机器码（pool_import / pro_redeem…），
                  直接摆在界面上等于让用户去读代码。这里映射成可读动作。 */}
              <Badge variant="soft">{t(`logs.actions.${log.action}`, { defaultValue: log.action })}</Badge>
            </TableCell>
            <TableCell className="max-w-[280px] truncate font-mono text-xs text-text-secondary">
              {log.target_type}:{log.target_id ?? '-'}
            </TableCell>
            <TableCell className="text-sm text-text-secondary">{formatDateTime(log.created_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
