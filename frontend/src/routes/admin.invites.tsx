import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { Modal } from '@/components/ui/modal'
import { Pagination } from '@/components/ui/pagination'
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.listInvites({ page, size })
      setInvites(result.items)
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
      title={t('sidebar.invites')}
      actions={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} /> {t('invites.create')}
        </Button>
      }
    >
      <TableCard>
        <InviteCodeTable
          invites={invites}
          loading={loading}
          onCopy={copy}
          onToggle={(invite) =>
            adminApi
              .updateInvite(invite.id, invite.status === 'active' ? 'disabled' : 'active')
              .then(() => void load())
              .catch((e) => toast.error(errorMessage(e, te)))
          }
          onDelete={(invite) =>
            adminApi.deleteInvite(invite.id).then(() => void load()).catch((e) => toast.error(errorMessage(e, te)))
          }
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
    </AdminShell>
  )
}
