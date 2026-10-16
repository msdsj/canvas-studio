import { useTranslation } from 'react-i18next'
import { Box } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas'

/** 右下角缩略导航（元素计数 + 提示）。 */
export function CanvasMinimap() {
  const { t } = useTranslation('canvas')
  const canvas = useCanvasStore((s) => s.canvas)
  const count = canvas?.state?.elements?.length ?? 0

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-2 rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-text-tertiary shadow-sm">
      <Box size={14} />
      <span>{t('minimap')}</span>
      <span className="font-mono text-text-secondary">{count}</span>
    </div>
  )
}
