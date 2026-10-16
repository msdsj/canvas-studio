import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { CircleSlash } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/stores/ui'

/** 额度不足拦截模态（P0-15）。 */
export function QuotaInsufficientModal() {
  const { t } = useTranslation('workspace')
  const open = useUIStore((s) => s.quotaModalOpen)
  const setOpen = useUIStore((s) => s.setQuotaModalOpen)
  const navigate = useNavigate()

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={
        <span className="flex items-center gap-2">
          <CircleSlash size={18} className="text-danger" /> {t('quota_modal.title')}
        </span>
      }
      description={t('quota_modal.desc')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {t('quota.view_detail')}
          </Button>
          <Button
            onClick={() => {
              setOpen(false)
              void navigate({ to: '/usage' })
            }}
          >
            {t('quota_modal.go_usage')}
          </Button>
        </>
      }
    />
  )
}
