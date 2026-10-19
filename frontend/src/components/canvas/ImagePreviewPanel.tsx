import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Download, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ImagePreviewPanelProps {
  /** 当前选中图（data URL） */
  imageUrl: string | null
  /** 已知的原图尺寸（可选，未传时自动读取） */
  width?: number
  height?: number
  onEdit?: () => void
  onDelete?: () => void
  onDownload?: (format: 'png' | 'jpg') => void
  /** 复制到剪贴板（PNG） */
  onCopy?: () => void
  /** 作为参考图交给 Agent（继续基于这张图创作） */
  onSendToChat?: () => void
  className?: string
}

const ACTION =
  'flex h-8 w-8 items-center justify-center rounded-[9px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring'

/**
 * 选中图片的信息卡（右下角导航器的上层）。
 *
 * 布局从「大预览 + 标题行」改成「小相纸 + 尺寸 + 一排动作」：
 * 图本身就在画布上、已经被选中高亮，这里再放一张 128px 的大图只是重复；
 * 用户此刻要的是「接下来能对它做什么」，所以动作是主角，预览退成辨认用的缩略图。
 * 「交给 Agent」是新增的主动作：选中一张图 → 一键带进对话继续改，画布与对话打通。
 */
export function ImagePreviewPanel({
  imageUrl,
  width,
  height,
  onEdit,
  onDelete,
  onDownload,
  onCopy,
  onSendToChat,
  className,
}: ImagePreviewPanelProps) {
  const { t } = useTranslation('stage')
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    if (!imageUrl) {
      setMeasured(null)
      return
    }
    if (width && height) {
      setMeasured({ w: width, h: height })
      return
    }
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive) setMeasured({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = imageUrl
    return () => {
      alive = false
    }
  }, [imageUrl, width, height])

  if (!imageUrl) return null

  const action = (label: string, icon: React.ReactNode, onClick?: () => void, danger = false) =>
    onClick ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn(ACTION, danger && 'hover:bg-danger-subtle hover:text-danger')}
          >
            {icon}
          </button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    ) : null

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-2.5">
        {/* 相纸缩略图：白衬边 + 近直角，与画布上的图片同一种物件感 */}
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-mat p-[2px] shadow-sheet">
          <img src={imageUrl} alt={t('preview.alt')} className="max-h-full max-w-full rounded-[2px] object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate whitespace-nowrap text-caption font-semibold text-text">{t('preview.title')}</p>
          <p className="truncate whitespace-nowrap font-mono text-micro tabular-nums text-text-tertiary">
            {measured ? `${measured.w} × ${measured.h}` : t('preview.reading')}
          </p>
        </div>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-brand px-3 text-caption font-semibold text-text-inverse shadow-sheet transition-[filter] hover:brightness-110"
          >
            <Pencil size={13} /> {t('preview.edit')}
          </button>
        )}
      </div>
      <div className="flex items-center gap-0.5 border-t border-border-faint pt-1.5">
        {action(t('preview.send_to_chat'), <MessageSquarePlus size={15} />, onSendToChat)}
        {action(t('preview.copy'), <Copy size={15} />, onCopy)}
        {onDownload && (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={t('preview.download')} className={ACTION}>
                    <Download size={15} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('preview.download')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem onClick={() => onDownload('png')}>{t('preview.download_png')}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDownload('jpg')}>{t('preview.download_jpg')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="flex-1" />
        {action(t('preview.delete'), <Trash2 size={15} />, onDelete, true)}
      </div>
    </div>
  )
}
