import { useTranslation } from 'react-i18next'
import { Download, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ImageNodeProps {
  url: string
  onMagicEdit?: () => void
  onDownload?: () => void
  onDelete?: () => void
}

/** 图片快捷操作条（用于结果卡/画布图片的浮动操作）。 */
export function ImageNode({ url, onMagicEdit, onDownload, onDelete }: ImageNodeProps) {
  const { t } = useTranslation('assets')
  return (
    <div className="group relative overflow-hidden rounded-md border border-border">
      <img src={url} alt="" className="block h-full w-full object-cover" />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-black/40 p-1 opacity-0 transition-opacity group-hover:opacity-100">
        {onMagicEdit && (
          <Button size="icon-sm" variant="ghost" className="text-white" aria-label="edit" onClick={onMagicEdit}>
            <Sparkles size={14} />
          </Button>
        )}
        {onDownload && (
          <Button size="icon-sm" variant="ghost" className="text-white" aria-label={t('card.download')} onClick={onDownload}>
            <Download size={14} />
          </Button>
        )}
        {onDelete && (
          <Button size="icon-sm" variant="ghost" className="text-white" aria-label={t('card.delete')} onClick={onDelete}>
            <Trash2 size={14} />
          </Button>
        )}
      </div>
    </div>
  )
}
