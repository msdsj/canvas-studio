import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { AuditLogTable } from '@/components/admin/AuditLogTable'
import { TableCard } from '@/components/ui/table'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { AuditLog } from '@/types/models'

export const Route = createFileRoute('/admin/logs')({
  component: AdminLogsPage,
})

function AdminLogsPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [actor, setActor] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.listLogs({ page, size, actor: actor || undefined })
      setLogs(result.items)
      setTotal(result.total)
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, actor])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <AdminShell title={t('sidebar.logs')} description={t('logs.hint')}>
      <div className="mb-4 w-64">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder={t('logs.search')}
            value={actor}
            onChange={(e) => {
              setActor(e.target.value)
              setPage(1)
            }}
          />
        </div>
      </div>

      <TableCard>
        <AuditLogTable logs={logs} loading={loading} />
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
    </AdminShell>
  )
}
