import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Download, Plus, RefreshCw, Search } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PoolStatsCards } from '@/components/admin/PoolStatsCards'
import { PoolTable } from '@/components/admin/PoolTable'
import { TableCard } from '@/components/ui/table'
import { PoolImportDialog, parseInput } from '@/components/admin/PoolImportDialog'
import { PoolRefreshProgress } from '@/components/admin/PoolRefreshProgress'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { PoolImportMethod } from '@/lib/api/admin'
import type { PoolImportResult } from '@/lib/api/admin'
import type { PoolAccount, PoolStats } from '@/types/models'

export const Route = createFileRoute('/admin/pool')({
  component: AdminPoolPage,
})

const ZERO: PoolStats = { total: 0, normal: 0, limited: 0, abnormal: 0, disabled: 0 }

function AdminPoolPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()

  const [stats, setStats] = useState<PoolStats>(ZERO)
  const [accounts, setAccounts] = useState<PoolAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [statusFilter, setStatusFilter] = useState('')
  const [q, setQ] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importResult, setImportResult] = useState<{ added: number; skipped: number; errors: number } | null>(null)
  const [refreshJob, setRefreshJob] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [statsData, accountsData] = await Promise.all([
        adminApi.poolStats().catch(() => ZERO),
        adminApi.poolAccounts({ status: statusFilter || undefined, q: q || undefined }).catch(() => ({ items: [] })),
      ])
      setStats(statsData)
      setAccounts(accountsData.items)
      setSelected([])
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, q])

  useEffect(() => {
    void load()
  }, [load])

  const handleImport = async (method: PoolImportMethod, raw: string) => {
    const { tokens, accounts: payloadAccounts } = parseInput(method, raw)
    try {
      const result: PoolImportResult = await adminApi.poolImport({ method, tokens, accounts: payloadAccounts })
      setImportResult({ added: result.added, skipped: result.skipped, errors: result.errors.length })
      toast.success(t('pool.import_result', { added: result.added, skipped: result.skipped, errors: result.errors.length }))
      void load()
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleRefresh = async () => {
    try {
      const result = await adminApi.poolRefresh(selected.length ? selected : undefined)
      setRefreshJob(result.job_id)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleDeleteSelected = async () => {
    if (selected.length === 0) return
    try {
      await adminApi.poolDelete(selected)
      toast.success(t('common:status.success', { defaultValue: '已删除' }))
      void load()
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleExport = async () => {
    try {
      const blob = await adminApi.poolExport(selected, 'json')
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'accounts.json'
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const toggleStatus = async (account: PoolAccount) => {
    // 账号状态切换需 access_token，此处仅针对已选（掩码不含明文）；交由上游导入/更新流程
    toast.info(`${account.token_masked} · ${account.status}`)
  }

  return (
    <AdminShell title={t('sidebar.pool')}>
      <PoolStatsCards stats={stats} />

      <div className="my-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => setImportOpen(true)}>
          <Plus size={16} /> {t('pool.import')}
        </Button>
        <Button variant="secondary" onClick={handleRefresh}>
          <RefreshCw size={16} /> {t('pool.refresh')}
        </Button>
        <Button variant="secondary" onClick={handleExport} disabled={selected.length === 0}>
          <Download size={16} /> {t('pool.export')}
        </Button>
        <Button variant="ghost" onClick={handleDeleteSelected} disabled={selected.length === 0}>
          {t('pool.delete')}
        </Button>
        <div className="relative w-56">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input className="pl-9" placeholder={t('pool.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('pool.status_all')}</SelectItem>
            <SelectItem value="normal">{t('pool.status.normal')}</SelectItem>
            <SelectItem value="limited">{t('pool.status.limited')}</SelectItem>
            <SelectItem value="abnormal">{t('pool.status.abnormal')}</SelectItem>
            <SelectItem value="disabled">{t('pool.status.disabled')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {refreshJob && (
        <div className="mb-4">
          <PoolRefreshProgress
            jobId={refreshJob}
            fetcher={adminApi.poolRefreshProgress}
            onDone={() => {
              toast.success(t('pool.refresh_done'))
              setRefreshJob(null)
              void load()
            }}
          />
        </div>
      )}

      <TableCard>
        <PoolTable
          accounts={accounts}
          loading={loading}
          selected={selected}
          onToggle={(token) =>
            setSelected((prev) => (prev.includes(token) ? prev.filter((t2) => t2 !== token) : [...prev, token]))
          }
          onToggleAll={() => setSelected(selected.length === accounts.length ? [] : accounts.map((a) => a.id))}
          onDelete={(token) => adminApi.poolDelete([token]).then(() => void load()).catch((e) => toast.error(errorMessage(e, te)))}
          onToggleStatus={toggleStatus}
        />
      </TableCard>

      <PoolImportDialog open={importOpen} onOpenChange={setImportOpen} onSubmit={handleImport} result={importResult} />
    </AdminShell>
  )
}
