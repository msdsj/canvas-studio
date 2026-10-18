import { useTranslation } from 'react-i18next'
import { ImagePlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { GenerationTask } from '@/types/models'

interface EditCompareCardProps {
  task: GenerationTask
  originalUrl?: string
  onAddToCanvas?: (task: GenerationTask) => void
  onRegenerate?: (task: GenerationTask) => void
}

/** 编辑对比卡（原图 / 新版本）。 */
export function EditCompareCard({ task, originalUrl, onAddToCanvas, onRegenerate }: EditCompareCardProps) {
  const { t } = useTranslation('chat')
  const result = task.result_urls[0]

  return (
    <div className="rounded-md bg-surface p-3 shadow-sheet">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-ui text-text-secondary">{t('edit.compare')}</span>
        {task.demo && <Badge variant="warning">{t('task.result_demo')}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <figure className="flex flex-col gap-1">
          <img src={originalUrl} alt={t('edit.original')} className="aspect-square w-full rounded-md object-cover ring-1 ring-inset ring-border-faint" />
          <figcaption className="text-micro text-text-tertiary">{t('edit.original')}</figcaption>
        </figure>
        <figure className="flex flex-col gap-1">
          {result ? (
            <img src={result} alt={t('edit.result')} className="aspect-square w-full rounded-md object-cover ring-1 ring-inset ring-border-faint" />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center rounded-md border border-dashed border-border-strong/70 text-micro text-text-tertiary">
              {t(`task.${task.status}`)}
            </div>
          )}
          <figcaption className="text-micro text-text-tertiary">{t('edit.result')}</figcaption>
        </figure>
      </div>
      {task.status === 'succeeded' && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" onClick={() => onAddToCanvas?.(task)}>
            <ImagePlus size={14} /> {t('task.add_to_canvas')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onRegenerate?.(task)}>
            <RefreshCw size={14} /> {t('task.regenerate')}
          </Button>
        </div>
      )}
    </div>
  )
}
