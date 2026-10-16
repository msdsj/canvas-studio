import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Maximize, ImagePlus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExcalidrawApiLike } from './canvas-helpers'

interface CanvasToolbarProps {
  api: ExcalidrawApiLike | null
  onAddImage?: () => void
  onDeleteSelected?: () => void
}

/** 左下角缩放控制 + 工具按钮。 */
export function CanvasToolbar({ api, onAddImage, onDeleteSelected }: CanvasToolbarProps) {
  const { t } = useTranslation('canvas')

  // Excalidraw 未暴露稳定的缩放 API，这里通过画布容器的滚轮事件实现缩放
  const zoom = (factor: number) => {
    const target = document.querySelector('.excalidraw') as HTMLElement | null
    if (!target) return
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: factor < 1 ? 120 : -120,
        ctrlKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      })
    )
  }

  const fit = () => {
    api?.scrollToContent()
  }

  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-border bg-surface-raised p-1 shadow-sm">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.zoom_out')} onClick={() => zoom(0.8)}>
            <ZoomOut size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.zoom_out')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.zoom_in')} onClick={() => zoom(1.25)}>
            <ZoomIn size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.zoom_in')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.fit')} onClick={fit}>
            <Maximize size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.fit')}</TooltipContent>
      </Tooltip>
      <span className="mx-1 h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.add_image')} onClick={onAddImage}>
            <ImagePlus size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.add_image')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.delete_selected')} onClick={onDeleteSelected}>
            <Trash2 size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.delete_selected')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
