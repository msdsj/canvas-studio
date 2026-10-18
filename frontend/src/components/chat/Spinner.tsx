import { useTranslation } from 'react-i18next'
import { Spinner as BaseSpinner } from '@/components/ui/spinner'

/** 进行中状态（生成中/排队中/已暂停）。 */
export function Spinner({ status }: { status?: 'queued' | 'running' | 'paused' }) {
  const { t } = useTranslation('chat')
  const label =
    status === 'queued'
      ? t('task.queued')
      : status === 'paused'
        ? t('task.paused')
        : t('task.running')
  return (
    <span className="inline-flex items-center gap-2 text-ui text-text-secondary">
      <BaseSpinner size={14} />
      {label}
    </span>
  )
}
