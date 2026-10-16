import { useTranslation } from 'react-i18next'
import { Pause, Play, X, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { GenerationTask } from '@/types/models'

interface TaskControlsProps {
  task: GenerationTask
  onPause?: (task: GenerationTask) => void
  onResume?: (task: GenerationTask) => void
  onCancel?: (task: GenerationTask) => void
  onRetry?: (task: GenerationTask) => void
  compact?: boolean
}

const STATUS_VARIANT: Record<string, 'soft' | 'brand' | 'success' | 'warning' | 'danger'> = {
  queued: 'soft',
  running: 'brand',
  paused: 'warning',
  succeeded: 'success',
  cancelled: 'soft',
  failed: 'danger',
  timeout: 'danger',
}

/** 任务控制按钮组 + 状态标签（暂停 / 继续 / 放弃 / 重试）。 */
export function TaskControls({ task, onPause, onResume, onCancel, onRetry, compact }: TaskControlsProps) {
  const { t } = useTranslation('chat')

  return (
    <div className="flex items-center gap-2">
      <Badge variant={STATUS_VARIANT[task.status] ?? 'soft'} dot>
        {t(`task.${task.status}`)}
      </Badge>
      {task.status === 'running' || task.status === 'queued' ? (
        <Button size="sm" variant="secondary" onClick={() => onPause?.(task)}>
          <Pause size={14} /> {t('task.pause')}
        </Button>
      ) : null}
      {task.status === 'paused' ? (
        <>
          <Button size="sm" variant="secondary" onClick={() => onResume?.(task)}>
            <Play size={14} /> {t('task.resume')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onCancel?.(task)}>
            <X size={14} /> {t('task.cancel')}
          </Button>
        </>
      ) : null}
      {task.status === 'failed' || task.status === 'timeout' ? (
        <Button size="sm" variant="secondary" onClick={() => onRetry?.(task)}>
          <RotateCcw size={14} /> {t('task.retry')}
        </Button>
      ) : null}
      {!compact && task.status === 'running' && onCancel ? (
        <Button size="sm" variant="ghost" onClick={() => onCancel(task)}>
          <X size={14} /> {t('task.cancel')}
        </Button>
      ) : null}
    </div>
  )
}
