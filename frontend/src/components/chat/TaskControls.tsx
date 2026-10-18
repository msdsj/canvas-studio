import { useTranslation } from 'react-i18next'
import { CircleStop, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { GenerationTask } from '@/types/models'

interface TaskControlsProps {
  task: GenerationTask
  onCancel?: (task: GenerationTask) => void
  onRetry?: (task: GenerationTask) => void
  compact?: boolean
  /** 请求在途：所有控制按钮禁用，避免连点产生 409 */
  busy?: boolean
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

/**
 * 任务状态标签 + 控制按钮。
 *
 * 只有一个破坏性操作：「停止生成」（= cancel，真退款）。
 * 不提供「暂停/继续」——上游是同步长请求，暂停不会中断上游，
 * 只会白烧一次调用并留下孤儿图，所以产品上不暴露这个能力。
 */
export function TaskControls({ task, onCancel, onRetry, busy }: TaskControlsProps) {
  const { t } = useTranslation('chat')
  const active = task.status === 'queued' || task.status === 'running' || task.status === 'paused'

  return (
    <div className="flex items-center gap-2">
      <Badge variant={STATUS_VARIANT[task.status] ?? 'soft'} dot>
        {t(`task.${task.status}`)}
      </Badge>
      {active && onCancel ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(task)}>
          <CircleStop size={14} /> {t('task.stop')}
        </Button>
      ) : null}
      {!active && onRetry ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRetry(task)}>
          <RotateCcw size={14} /> {t('task.retry')}
        </Button>
      ) : null}
    </div>
  )
}
