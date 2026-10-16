import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CloudUpload, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useCanvasStore } from '@/stores/canvas'
import { CanvasExport } from './CanvasExport'

interface CanvasHeaderProps {
  canvasId: string | null
  onShare?: () => void
}

/** 画布顶部工具栏：名称 + 保存态 + 分享 + 导出。 */
export function CanvasHeader({ canvasId, onShare }: CanvasHeaderProps) {
  const { t } = useTranslation('canvas')
  const canvas = useCanvasStore((s) => s.canvas)
  const saveStatus = useCanvasStore((s) => s.saveStatus)
  const [shared, setShared] = useState(false)

  const statusNode =
    saveStatus === 'saving' ? (
      <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <Spinner size={12} /> {t('save.saving')}
      </span>
    ) : saveStatus === 'dirty' ? (
      <span className="flex items-center gap-1.5 text-xs text-warning">
        <CloudUpload size={13} /> {t('save.dirty')}
      </span>
    ) : saveStatus === 'error' ? (
      <span className="text-xs text-danger">{t('save.error')}</span>
    ) : (
      <span className="flex items-center gap-1.5 text-xs text-success">
        <Check size={13} /> {t('save.saved')}
      </span>
    )

  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-medium text-text">{canvas?.name || t('untitled')}</span>
        {statusNode}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onShare?.()
            setShared(true)
          }}
        >
          <Share2 size={15} /> {t('share.title')}
        </Button>
        {shared && <span className="text-xs text-text-tertiary">{t('share.enabled_hint')}</span>}
        <CanvasExport canvasId={canvasId} />
      </div>
    </div>
  )
}
