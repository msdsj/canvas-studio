import { useTranslation } from 'react-i18next'
import { ImagePlus, Pencil, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Spinner } from './Spinner'
import { TaskControls } from './TaskControls'
import type { GenerationTask } from '@/types/models'

interface GenerationResultCardProps {
  task: GenerationTask
  onAddToCanvas?: (task: GenerationTask) => void
  /** 直接在编辑画布中打开该结果（免下载上传） */
  onEdit?: (task: GenerationTask) => void
  onRegenerate?: (task: GenerationTask) => void
  onPause?: (task: GenerationTask) => void
  onResume?: (task: GenerationTask) => void
  onCancel?: (task: GenerationTask) => void
  onRetry?: (task: GenerationTask) => void
  onSeen?: (task: GenerationTask) => void
}

/** 生图结果卡（加入画布 / 再生成 / 暂停恢复 / 演示标注）。 */
export function GenerationResultCard({
  task,
  onAddToCanvas,
  onEdit,
  onRegenerate,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onSeen,
}: GenerationResultCardProps) {
  const { t } = useTranslation('chat')
  const inProgress = task.status === 'queued' || task.status === 'running' || task.status === 'paused'

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="truncate text-sm text-text-secondary">{task.prompt.slice(0, 40)}</span>
        {task.demo && <Badge variant="warning">{t('task.result_demo')}</Badge>}
        {!task.result_seen && task.status === 'succeeded' && (
          <Badge variant="brand">{t('task.unread')}</Badge>
        )}
      </div>

      {inProgress && (
        <div className="mb-2">
          <Spinner status={task.status === 'paused' ? 'paused' : task.status} />
          <Progress value={task.progress} className="mt-2" />
        </div>
      )}

      {task.status === 'succeeded' && task.result_urls.length > 0 && (
        <div className="mb-2 grid grid-cols-2 gap-2">
          {task.result_urls.map((url) => (
            <img
              key={url}
              src={url}
              alt={task.prompt}
              loading="lazy"
              className="aspect-square w-full rounded-md border border-border object-cover"
              onClick={() => onSeen?.(task)}
            />
          ))}
        </div>
      )}

      {task.status === 'failed' || task.status === 'timeout' ? (
        <p className="mb-2 text-sm text-danger">
          {task.error_message || t(`task.${task.status}`)}
          {task.error_code ? ` · ${task.error_code}` : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <TaskControls
          task={task}
          onPause={onPause}
          onResume={onResume}
          onCancel={onCancel}
          onRetry={onRetry}
        />
        {task.status === 'succeeded' && (
          <>
            <Button size="sm" onClick={() => onAddToCanvas?.(task)}>
              <ImagePlus size={14} /> {t('task.add_to_canvas')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onEdit?.(task)}>
              <Pencil size={14} /> {t('task.edit_image', { defaultValue: '编辑' })}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onRegenerate?.(task)}>
              <RefreshCw size={14} /> {t('task.regenerate')}
            </Button>
          </>
        )}
        {task.demo && (
          <span className="flex items-center gap-1 text-xs text-text-tertiary">
            <Sparkles size={12} /> {t('demo_hint')}
          </span>
        )}
      </div>
    </div>
  )
}
