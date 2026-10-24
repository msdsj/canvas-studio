import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Wallet, TriangleAlert, CircleSlash, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { quotaState } from '@/stores/quota'
import { useQuota } from '@/hooks/use-quota'
import { useUIStore } from '@/stores/ui'
import { tweenNumber } from '@/lib/motion'

/**
 * 额度徽章：正常 / 预警 / 耗尽 三态。
 *
 * `compact`：**上下布局**（图标在上、数字在下），单块约 40px 宽，
 * 用于工作区左上角贴边摆放，不跟画布抢横向空间。
 *
 * 数字用 tweenNumber 滚动：额度是"余额"类信息，突然从一个数跳到另一个数
 * 用户会怀疑自己看错了；滚动 420ms 既确认了变化，又不打断操作。
 * 滚动只写 textContent，不触发 React 重渲染。
 */
export function QuotaBadge({
  compact = false,
  chip = false,
}: {
  compact?: boolean
  /** 胶囊形态（⚡ 数字）：工作台顶栏用，与 Lovart 的积分显示同构 */
  chip?: boolean
}) {
  const { t } = useTranslation('workspace')
  const { balance, thresholdPct, totalGranted } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)
  const state = quotaState(balance, thresholdPct, totalGranted)

  const numberRef = useRef<HTMLSpanElement>(null)
  const prevRef = useRef<number | null>(null)

  useEffect(() => {
    const el = numberRef.current
    if (!el) return
    // 首次挂载不滚动：从 0 滚到 11684 会让人以为额度刚被扣掉了一大截
    if (prevRef.current === null) {
      prevRef.current = balance
      el.textContent = String(balance)
      return
    }
    if (prevRef.current === balance) return
    tweenNumber(el, prevRef.current, balance)
    prevRef.current = balance
  }, [balance])

  const Icon = state === 'normal' ? Wallet : state === 'warning' ? TriangleAlert : CircleSlash
  const tone =
    state === 'normal'
      ? 'text-text-secondary hover:bg-surface-hover'
      : state === 'warning'
        ? 'bg-warning-subtle text-warning hover:opacity-90'
        : 'bg-danger-subtle text-danger hover:opacity-90'

  if (chip) {
    return (
      <button
        type="button"
        onClick={() => state !== 'normal' && setQuotaModalOpen(true)}
        className={cn(
          'inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption font-semibold tabular-nums transition-colors',
          state === 'normal' ? 'text-text hover:bg-surface-hover' : tone
        )}
        title={`${balance} ${t('quota.badge_label')}`}
        aria-label={`${balance} ${t('quota.badge_label')}`}
      >
        {state === 'normal' ? (
          <Zap size={14} className="fill-accent text-accent-ink" />
        ) : (
          <Icon size={14} />
        )}
        <span ref={numberRef}>{balance}</span>
      </button>
    )
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => state !== 'normal' && setQuotaModalOpen(true)}
        className={cn(
          'flex h-9 w-9 flex-col items-center justify-center gap-0 rounded-[8px] transition-colors',
          tone
        )}
        title={`${balance} ${t('quota.badge_label')}`}
        aria-label={`${balance} ${t('quota.badge_label')}`}
      >
        <Icon size={12} />
        <span ref={numberRef} className="text-[10px] font-semibold leading-none tabular-nums">
          {balance}
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => state !== 'normal' && setQuotaModalOpen(true)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-ui font-medium transition-colors',
        tone
      )}
      title={t('quota.badge_label')}
    >
      <Icon size={15} />
      <span>
        <span ref={numberRef}>{balance}</span>{' '}
        {/* 手机上只留数字：整句「11534 Creation credits」会把品牌名压到重叠 */}
        <span className="hidden sm:inline">{t('quota.badge_label')}</span>
      </span>
    </button>
  )
}
