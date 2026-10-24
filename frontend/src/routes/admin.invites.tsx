import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { ConfirmModal, Modal } from '@/components/ui/modal'
import { Pagination } from '@/components/ui/pagination'
import { BulkBar } from '@/components/admin/BulkBar'
import { InviteCodeTable } from '@/components/admin/InviteCodeTable'
import { TableCard } from '@/components/ui/table'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { InviteCode } from '@/types/models'

export const Route = createFileRoute('/admin/invites')({
  component: AdminInvitesPage,
})

function AdminInvitesPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [maxUses, setMaxUses] = useState('1')
  const [selected, setSelected] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<InviteCode | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.listInvites({ page, size })
      setInvites(result.items)
      setTotal(result.total)
      setSelected([])
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

  /** 批量操作：逐个调用接口后统一提示，失败不影响其余行 */
  const runBulk = async (ids: string[], task: (id: string) => Promise<unknown>) => {
    const results = await Promise.allSettled(ids.map(task))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.length - ok
    if (failed === 0) toast.success(t('bulk.done', { count: ok }))
    else toast.error(t('bulk.partial', { ok, failed }))
    void load()
  }

  return (
    <AdminShell
      title={t('sidebar.invites')}
      description={t('invites.hint')}
      actions={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} /> {t('invites.create')}
        </Button>
      }
    >
      <BulkBar
        count={selected.length}
        onClear={() => setSelected([])}
        actions={[
          {
            label: t('bulk.enable'),
            onClick: () => void runBulk(selected, (id) => adminApi.updateInvite(id, 'active')),
          },
          {
            label: t('bulk.disable'),
            onClick: () => void runBulk(selected, (id) => adminApi.updateInvite(id, 'disabled')),
          },
          {
            label: t('bulk.delete'),
            danger: true,
            onClick: () => {
              if (!window.confirm(t('bulk.confirm_delete', { count: selected.length }))) return
              void runBulk(selected, (id) => adminApi.deleteInvite(id))
            },
          },
        ]}
      />

      <TableCard>
        <InviteCodeTable
          invites={invites}
          loading={loading}
          selected={selected}
          onToggleRow={(invite) =>
            setSelected((prev) =>
              prev.includes(invite.id) ? prev.filter((id) => id !== invite.id) : [...prev, invite.id],
            )
          }
          onToggleAll={() =>
            setSelected((prev) => (prev.length === invites.length ? [] : invites.map((invite) => invite.id)))
          }
          onCopy={copy}
          onToggle={(invite) =>
            adminApi
              .updateInvite(invite.id, invite.status === 'active' ? 'disabled' : 'active')
              .then(() => void load())
              .catch((e) => toast.error(errorMessage(e, te)))
          }
          onDelete={setDeleteTarget}
        />
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

      <Modal
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t('invites.create')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              {t('common:cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              onClick={async () => {
                try {
                  await adminApi.createInvite({ max_uses: Number(maxUses) || 1 })
                  setCreateOpen(false)
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
        <FormField label={t('invites.max_uses')}>
          <Input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
        </FormField>
      </Modal>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('bulk.delete')}
        description={deleteTarget?.code}
        danger
        confirmLabel={t('bulk.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await adminApi.deleteInvite(deleteTarget.id)
            setDeleteTarget(null)
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
      />
    </AdminShell>
  )
}
