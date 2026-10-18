import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CloudUpload, Download, Loader2 } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useToast } from '@/hooks/use-toast'
import { useCanvasStore } from '@/stores/canvas'
import { cn } from '@/lib/utils'
import { downloadSelectedImages, type ExportFormat } from './canvas-helpers'
import type { ExcalidrawApiLike } from './canvas-helpers'

interface CanvasHeaderProps {
  canvasId: string | null
  api?: ExcalidrawApiLike | null
  /** 画布上至少选中了一张图片：只有这时「导出」才可用 */
  hasImageSelected?: boolean
  className?: string
}

/**
 * 画布顶部标题条：项目 · 画布 + 保存态 + 导出。
 *
 * 分享已移到**对话卡片右下角**（分享的是整段对话，不是画布），
 * 这条 bar 只保留与画布本身有关的信息。
 */
export function CanvasHeader({
  canvasId,
  api,
  hasImageSelected = false,
  className,
}: CanvasHeaderProps) {
  const { t } = useTranslation('canvas')
  const toast = useToast()
  const canvas = useCanvasStore((s) => s.canvas)
  const projectName = useCanvasStore((s) => s.projectName)
  const saveStatus = useCanvasStore((s) => s.saveStatus)
  const [exportBusy, setExportBusy] = useState(false)

  const statusNode =
    saveStatus === 'saving' ? (
      <span className="flex shrink-0 items-center gap-1 text-caption text-text-tertiary">
        <Spinner size={11} /> {t('save.saving')}
      </span>
    ) : saveStatus === 'dirty' ? (
      <span className="flex shrink-0 items-center gap-1 text-caption text-text-warning">
        <CloudUpload size={11} /> {t('save.dirty')}
      </span>
    ) : saveStatus === 'error' ? (
      <span className="shrink-0 text-caption text-danger">{t('save.error')}</span>
    ) : (
      <span className="flex shrink-0 items-center gap-1 text-caption text-success">
        <Check size={11} /> {t('save.saved')}
      </span>
    )

  const doExport = useCallback(
    async (format: ExportFormat) => {
      if (!api || !hasImageSelected) return
      setExportBusy(true)
      try {
        const count = await downloadSelectedImages(api, format)
        if (count === 0) toast.info('先选中图片', '点一下画布上的图片再导出')
        else toast.success(`已导出 ${count} 张`, format.toUpperCase())
      } catch (error) {
        toast.error('导出失败', (error as Error).message)
      } finally {
        setExportBusy(false)
      }
    },
    [api, hasImageSelected, toast]
  )

  return (
    <div className={cn('flex h-11 shrink-0 items-center gap-2 px-2', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-ui font-medium text-text">
          {projectName ? (
            <>
              <span className="text-text-secondary">{projectName}</span>
              <span className="mx-1.5 text-text-faint">·</span>
            </>
          ) : null}
          {canvas?.name || t('untitled')}
        </span>
        {statusNode}
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={!hasImageSelected || exportBusy || !canvasId}
            title={hasImageSelected ? '导出选中的图片' : '先在画布上选中图片'}
            aria-label="导出选中的图片"
            className={cn(
              'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] transition-colors',
              hasImageSelected
                ? 'text-text-secondary hover:bg-brand-subtle hover:text-brand-text'
                : 'text-text-faint'
            )}
          >
            {exportBusy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[168px] p-1">
          {(['png', 'jpg'] as ExportFormat[]).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => void doExport(format)}
              className="flex w-full items-center justify-between rounded-[8px] px-2.5 py-1.5 text-caption text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <span>{format.toUpperCase()}</span>
              <span className="text-micro text-text-faint">{format === 'png' ? '透明' : '白底'}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
