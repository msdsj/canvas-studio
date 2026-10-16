import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AdminShell } from '@/components/layout/AdminShell'
import { AnnouncementEditor } from '@/components/admin/AnnouncementEditor'
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

  const load = useCallback(async () => {
    try {
      const result = await adminApi.listAnnouncements({ size: 50 })
      setItems(result.items)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <AdminShell title={t('sidebar.announcements')}>
      <AnnouncementEditor
        announcements={items}
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
          try {
            await adminApi.deleteAnnouncement(id)
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
      />
    </AdminShell>
  )
}
