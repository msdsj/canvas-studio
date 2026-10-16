import { ImagePlus, Upload, Trash2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { CanvasMenuButton } from './CanvasMenuButton'

interface CanvasToolMenuProps {
  onAddImage?: () => void
  onUpload?: () => void
  onDeleteSelected?: () => void
  onMagicEdit?: () => void
}

/** 画布工具菜单。 */
export function CanvasToolMenu({ onAddImage, onUpload, onDeleteSelected, onMagicEdit }: CanvasToolMenuProps) {
  const { t } = useTranslation('canvas')
  const { t: tc } = useTranslation('workspace')
  return (
    <CanvasMenuButton label={t('toolbar.select')}>
      <DropdownMenuItem onClick={onAddImage}>
        <ImagePlus size={15} /> {t('toolbar.add_image')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onUpload}>
        <Upload size={15} /> {tc('leftbar.upload')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onMagicEdit}>
        <Sparkles size={15} /> {t('magic', { defaultValue: 'AI 编辑' })}
      </DropdownMenuItem>
      <DropdownMenuItem danger onClick={onDeleteSelected}>
        <Trash2 size={15} /> {t('toolbar.delete_selected')}
      </DropdownMenuItem>
    </CanvasMenuButton>
  )
}
