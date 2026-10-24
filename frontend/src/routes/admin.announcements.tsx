import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AdminShell } from '@/components/layout/AdminShell'
import { AnnouncementEditor } from '@/components/admin/AnnouncementEditor'
import { BulkBar } from '@/components/admin/BulkBar'
import { Pagination } from '@/components/ui/pagination'
import { ConfirmModal } from '@/components/ui/modal'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { Announcement } from '@/types/models'

export const Route = createFileRoute('/admin/announcements')({
  component: AdminAnnouncementsPage,
})

function AdminAnnouncementsPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()
  const [items, setItems] = useState<Announcement[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [selected, setSelected] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await adminApi.listAnnouncements({ page, size })
      setItems(result.items)
      setTotal(result.total)
      setSelected([])
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size])

  useEffect(() => {
    void load()
  }, [load])

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
    <AdminShell title={t('sidebar.announcements')} description={t('announcements.hint')}>
      <BulkBar
        count={selected.length}
        onClear={() => setSelected([])}
        actions={[
          {
            label: t('bulk.publish'),
            onClick: () => void runBulk(selected, (id) => adminApi.updateAnnouncement(id, { status: 'published' })),
          },
          {
            label: t('bulk.archive'),
            onClick: () => void runBulk(selected, (id) => adminApi.updateAnnouncement(id, { status: 'archived' })),
          },
          {
            label: t('bulk.delete'),
            danger: true,
            onClick: () => {
              if (!window.confirm(t('bulk.confirm_delete', { count: selected.length }))) return
              void runBulk(selected, (id) => adminApi.deleteAnnouncement(id))
            },
          },
        ]}
      />

      <AnnouncementEditor
        announcements={items}
        selected={selected}
        onToggleRow={(a) =>
          setSelected((prev) => (prev.includes(a.id) ? prev.filter((id) => id !== a.id) : [...prev, a.id]))
        }
        onToggleAll={() =>
          setSelected((prev) => (prev.length === items.length ? [] : items.map((a) => a.id)))
        }
        onCreate={async (payload) => {
          try {
            await adminApi.createAnnouncement(payload)
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
        onUpdate={async (id, payload) => {
          try {
            await adminApi.updateAnnouncement(id, payload)
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
        onDelete={async (id) => {
          const target = items.find((a) => a.id === id)
          if (target) setDeleteTarget(target)
        }}
      />

      <Pagination
        page={page}
        size={size}
        total={total}
        onPageChange={setPage}
        onSizeChange={(next) => {
          setSize(next)
          setPage(1)
        }}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('bulk.delete')}
        description={deleteTarget?.title}
        danger
        confirmLabel={t('bulk.delete')}
        onConfirm={async () => {
          if (!deleteTarget) return
          try {
            await adminApi.deleteAnnouncement(deleteTarget.id)
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
