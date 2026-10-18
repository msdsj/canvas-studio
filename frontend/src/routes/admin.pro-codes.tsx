import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Copy, Plus, Power, Trash2 } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/utils'
import type { ProCode } from '@/types/models'

export const Route = createFileRoute('/admin/pro-codes')({
  component: AdminProCodesPage,
})

/**
 * 后台 Pro 激活码管理。
 *
 * 这是本产品**唯一的 Pro 开通通道**（没有支付设施），因此这一页的定位是
 * 「发放工具」：一次生成一批、复制给用户、必要时禁用或删除。
 */
function AdminProCodesPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()

  const [codes, setCodes] = useState<ProCode[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [count, setCount] = useState('1')
  const [maxUses, setMaxUses] = useState('1')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.listProCodes({ page, size })
      setCodes(result.items)
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

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code).catch(() => undefined)
    toast.success(t('common:action.copied', { defaultValue: '已复制' }))
  }

  return (
    <AdminShell
      title={t('sidebar.pro_codes')}
      actions={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} /> {t('pro_codes.create')}
        </Button>
      }
    >
      <p className="mb-3 text-caption text-text-tertiary">{t('pro_codes.hint')}</p>

      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : codes.length === 0 ? (
        <EmptyState title={t('pro_codes.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('pro_codes.code')}</TableHead>
              <TableHead>{t('pro_codes.note')}</TableHead>
              <TableHead>{t('pro_codes.max_uses')}</TableHead>
              <TableHead>{t('pro_codes.used')}</TableHead>
              <TableHead>{t('pro_codes.status')}</TableHead>
              <TableHead>{t('pro_codes.expires_at')}</TableHead>
              <TableHead className="text-right">{t('users.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {codes.map((code) => (
              <TableRow key={code.id}>
                <TableCell className="font-mono tracking-[0.08em]">{code.code}</TableCell>
                <TableCell className="text-text-secondary">{code.note || '—'}</TableCell>
                <TableCell>{code.max_uses}</TableCell>
                <TableCell>{code.used_count}</TableCell>
                <TableCell>
                  <Badge variant={code.status === 'active' ? 'success' : 'soft'} dot>
                    {code.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-text-secondary">
                  {code.expires_at ? formatDateTime(code.expires_at) : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('pro_codes.copy')}
                      onClick={() => void copy(code.code)}
                    >
                      <Copy size={15} />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="toggle"
                      onClick={() =>
                        adminApi
                          .updateProCode(code.id, code.status === 'active' ? 'disabled' : 'active')
                          .then(() => void load())
                          .catch((e) => toast.error(errorMessage(e, te)))
                      }
                    >
                      <Power size={15} />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="delete"
                      onClick={() =>
                        adminApi
                          .deleteProCode(code.id)
                          .then(() => void load())
                          .catch((e) => toast.error(errorMessage(e, te)))
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </TableCell>
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

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('pro_codes.create')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              {t('common:cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              onClick={async () => {
                try {
                  const amount = Math.max(1, Math.min(200, Number(count) || 1))
                  const result = await adminApi.createProCodes({
                    count: amount,
                    max_uses: Math.max(1, Number(maxUses) || 1),
                    note,
                  })
                  setCreateOpen(false)
                  setNote('')
                  toast.success(t('pro_codes.created', { count: result.items.length }))
                  void load()
                } catch (error) {
                  toast.error(errorMessage(error, te))
                }
              }}
            >
              {t('common:action.confirm', { defaultValue: '生成' })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <FormField label={t('pro_codes.count')}>
            <Input type="number" min={1} max={200} value={count} onChange={(e) => setCount(e.target.value)} />
          </FormField>
          <FormField label={t('pro_codes.max_uses')}>
            <Input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </FormField>
          <FormField label={t('pro_codes.note')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={128} placeholder="例：内测第 1 批" />
          </FormField>
        </div>
      </Modal>
    </AdminShell>
  )
}
