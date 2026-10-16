import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { CanvasMenuButton } from './CanvasMenuButton'

interface CanvasViewMenuProps {
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFit?: () => void
}

/** 画布视图菜单。 */
export function CanvasViewMenu({ onZoomIn, onZoomOut, onFit }: CanvasViewMenuProps) {
  const { t } = useTranslation('canvas')
  return (
    <CanvasMenuButton label={t('toolbar.fit')} align="end">
      <DropdownMenuItem onClick={onZoomIn}>
        <ZoomIn size={15} /> {t('toolbar.zoom_in')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onZoomOut}>
        <ZoomOut size={15} /> {t('toolbar.zoom_out')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onFit}>
        <Maximize size={15} /> {t('toolbar.fit')}
      </DropdownMenuItem>
    </CanvasMenuButton>
  )
}
