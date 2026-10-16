import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { canvasesApi } from '@/lib/api/canvases'
import { useToast } from '@/hooks/use-toast'

/** 导出 PNG / JSON。 */
export function CanvasExport({ canvasId }: { canvasId: string | null }) {
  const { t } = useTranslation('canvas')
  const toast = useToast()

  const downloadFile = (url: string, filename: string) => {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  const handle = (format: 'png' | 'json') => {
    if (!canvasId) {
      toast.error('未保存的画布无法导出')
      return
    }
    downloadFile(canvasesApi.exportUrl(canvasId, format), `canvas-${canvasId}.${format}`)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <Download size={15} /> {t('export.title')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => handle('png')}>{t('export.png')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => handle('json')}>{t('export.json')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
