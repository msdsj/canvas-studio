import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { exportToBlob } from '@excalidraw/excalidraw'
import { ChevronDown, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useToast } from '@/hooks/use-toast'
import { downloadBlob, type ExcalidrawApiLike } from './canvas-helpers'

type ExportFormat = 'png' | 'jpg'

/** 导出画布为 PNG / JPG（客户端真实渲染，所见即所得）。 */
export function CanvasExport({ api }: { api: ExcalidrawApiLike | null }) {
  const { t } = useTranslation('canvas')
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const handle = async (format: ExportFormat) => {
    if (!api || busy) return
    const elements = api.getSceneElements()
    if (elements.length === 0) {
      toast.error('画布是空的，先放一张图片再导出')
      return
    }
    setBusy(true)
    try {
      const appState = api.getAppState() as Record<string, unknown>
      const blob = await exportToBlob({
        elements: elements as never,
        files: api.getFiles() as never,
        mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png',
        quality: format === 'jpg' ? 0.92 : undefined,
        appState: {
          ...(appState as never),
          // 导出时铺满背景：JPG 不支持透明，统一白底避免出现黑块
          exportBackground: true,
          viewBackgroundColor: format === 'jpg' ? '#ffffff' : (appState.viewBackgroundColor ?? '#ffffff'),
        },
      })
      downloadBlob(blob, `canvas-${Date.now()}.${format}`)
      toast.success(format === 'jpg' ? '已导出 JPG' : '已导出 PNG')
    } catch {
      toast.error('导出失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={busy}>
          <Download size={15} /> {t('export.title')} <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handle('png')}>导出 PNG（支持透明）</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handle('jpg')}>导出 JPG（体积更小）</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
