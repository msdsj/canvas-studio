import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ImagePlus, Layers, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ExcalidrawApiLike } from './canvas-helpers'

interface CanvasToolbarProps {
  /** 保留参数以兼容调用方；缩放交给 Excalidraw 原生缩放岛 */
  api?: ExcalidrawApiLike | null
  onAddImage?: () => void
  onUpload?: () => void
  onDeleteSelected?: () => void
  /** 图层面板（点图标在画布上就地弹出，不再占一条常驻侧栏） */
  layersSlot?: ReactNode
}

/**
 * 画布浮动工具岛（底部居中）。
 *
 * 原来的左侧工具 + 图层面板是「后台系统」的做法：常驻 240px，压缩画布。
 * 现在收成一颗胶囊，图层按需弹出——画布优先。
 */
export function CanvasToolbar({
  onAddImage,
  onUpload,
  onDeleteSelected,
  layersSlot,
}: CanvasToolbarProps) {
  const { t } = useTranslation('canvas')

  return (
    <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full bg-surface-raised/95 p-1 shadow-lift ring-1 ring-border-faint backdrop-blur">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.add_image')} onClick={onAddImage}>
            <ImagePlus size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.add_image')}</TooltipContent>
      </Tooltip>
      {onUpload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.upload')} onClick={onUpload}>
              <Upload size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.upload')}</TooltipContent>
        </Tooltip>
      )}
      {layersSlot && (
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('toolbar.layers')}>
                  <Layers size={16} />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('toolbar.layers')}</TooltipContent>
          </Tooltip>
          <PopoverContent side="top" align="center" className="w-64 overflow-hidden p-0">
            {layersSlot}
          </PopoverContent>
        </Popover>
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('toolbar.delete_selected')}
            onClick={onDeleteSelected}
          >
            <Trash2 size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.delete_selected')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
