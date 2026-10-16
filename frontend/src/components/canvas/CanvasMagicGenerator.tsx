import { Download, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface CanvasMagicGeneratorProps {
  /** 进入 AI 编辑（框选修改） */
  onMagicEdit?: () => void
  /** 进入涂鸦标注模式 */
  onDoodle?: () => void
  /** 下载选中图片原图 */
  onDownload?: () => void
  /** 删除选中元素 */
  onDelete?: () => void
  disabled?: boolean
}

/** 选中图片后的浮动操作条（编辑 / 涂鸦 / 下载 / 删除，胶囊风格，贴近 Figma 习惯）。 */
export function CanvasMagicGenerator({
  onMagicEdit,
  onDoodle,
  onDownload,
  onDelete,
  disabled,
}: CanvasMagicGeneratorProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('canvas')
  return (
    <div className="absolute left-1/2 top-16 z-10 -translate-x-1/2">
      <div className="flex items-center gap-0.5 rounded-full border border-border bg-surface/95 p-1 shadow-lg backdrop-blur">
        <button
          type="button"
          disabled={disabled}
          onClick={onMagicEdit}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-text-inverse transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Sparkles size={14} /> {t('mode.edit')}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onDoodle}
          title={tc('toolbar.doodle', { defaultValue: '在图上手绘标注后提交修改' })}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          <Pencil size={14} /> {tc('toolbar.doodle', { defaultValue: '涂鸦' })}
        </button>
        <button
          type="button"
          disabled={disabled}
          title={tc('toolbar.download', { defaultValue: '下载图片' })}
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
        >
          <Download size={14} /> {tc('toolbar.download', { defaultValue: '下载' })}
        </button>
        <button
          type="button"
          disabled={disabled}
          title={tc('toolbar.delete_short', { defaultValue: '删除' })}
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-danger-subtle hover:text-danger disabled:opacity-50"
        >
          <Trash2 size={14} /> {tc('toolbar.delete_short', { defaultValue: '删除' })}
        </button>
      </div>
    </div>
  )
}
