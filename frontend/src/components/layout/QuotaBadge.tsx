import { useTranslation } from 'react-i18next'
import { Wallet, TriangleAlert, CircleSlash } from 'lucide-react'
import { cn } from '@/lib/utils'
import { quotaState } from '@/stores/quota'
import { useQuota } from '@/hooks/use-quota'
import { useUIStore } from '@/stores/ui'

/** 额度徽章：正常 / 预警 / 耗尽 三态。 */
export function QuotaBadge() {
  const { t } = useTranslation('workspace')
  const { balance, thresholdPct, totalGranted } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)
  const state = quotaState(balance, thresholdPct, totalGranted)

  const Icon = state === 'normal' ? Wallet : state === 'warning' ? TriangleAlert : CircleSlash
  const tone =
    state === 'normal'
      ? 'text-text-secondary hover:bg-surface-hover'
      : state === 'warning'
        ? 'bg-warning-subtle text-warning hover:opacity-90'
        : 'bg-danger-subtle text-danger hover:opacity-90'

  return (
    <button
      type="button"
      onClick={() => state !== 'normal' && setQuotaModalOpen(true)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors',
        tone
      )}
      title={t('quota.label')}
    >
      <Icon size={15} />
      <span>{balance} {t('quota.label')}</span>
    </button>
  )
}
