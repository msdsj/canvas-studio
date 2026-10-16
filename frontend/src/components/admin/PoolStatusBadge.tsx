import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { PoolAccount } from '@/types/models'

const VARIANT: Record<PoolAccount['status'], 'success' | 'warning' | 'danger' | 'soft'> = {
  normal: 'success',
  limited: 'warning',
  abnormal: 'danger',
  disabled: 'soft',
}

/** 号池状态徽章（soft 变体 + 圆点）。 */
export function PoolStatusBadge({ status }: { status: PoolAccount['status'] }) {
  const { t } = useTranslation('admin')
  return (
    <Badge variant={VARIANT[status] ?? 'soft'} dot>
      {t(`pool.status.${status}`)}
    </Badge>
  )
}
