import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Hourglass, RotateCcw, Square, WifiOff } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { formatWait, type StageTimer } from '@/hooks/use-stage-timer'

interface WaitStatusProps {
  timer: StageTimer
  /** 当前阶段的一句话（「正在理解需求」「正在出图」…），由调用方按进度决定 */
  label: string
  /** 'analysis' 与 'generation' 的提示文案不同：分析慢多半是中转站，出图慢多半是排队 */
  kind: 'analysis' | 'generation'
  offline?: boolean
  onStop?: () => void
  onRetry?: () => void
  className?: string
}

/**
 * 模型调用的统一等待条：阶段文案 + 计时 + 渐近进度 + 软/硬超时容错。
 *
 * 三段式：
 * - normal：只有一条细进度条与计时，不打扰；
 * - slow（软超时）：补一句「比平时慢，仍在处理」，告诉用户这不是卡死；
 * - stalled（硬超时）：把决定权交给用户——继续等 / 停止 / 重试。
 *   这里**不自动取消**：上游可能马上就回来了，自动取消等于白烧一次调用。
 */
export function WaitStatus({
  timer,
  label,
  kind,
  offline = false,
  onStop,
  onRetry,
  className,
}: WaitStatusProps) {
  const { t } = useTranslation('agent')
  const barRef = useRef<HTMLSpanElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)

  // 进度条用 scaleX 补间：每秒一次的跳变被抹平成连续的滑动
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    if (shouldReduceMotion()) gsap.set(bar, { scaleX: timer.progress })
    else gsap.to(bar, { scaleX: timer.progress, duration: 1, ease: 'none', overwrite: 'auto' })
  }, [timer.progress])

  // 提示条出现时轻轻落下，而不是突然插进一行把列表顶跳
  useLayoutEffect(() => {
    const notice = noticeRef.current
    if (!notice || shouldReduceMotion()) return
    gsap.fromTo(
      notice,
      { height: 0, opacity: 0 },
      { height: 'auto', opacity: 1, duration: 0.38, ease: 'power3.out', clearProps: 'height' }
    )
  }, [timer.phase, offline])

  const stalled = timer.phase === 'stalled'
  const slow = timer.phase === 'slow'

  return (
    <div className={cn('min-w-0', className)} role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-micro text-text-secondary">{label}</span>
        <span className="shrink-0 text-micro tabular-nums text-text-tertiary">
          {formatWait(timer.elapsed)}
        </span>
      </div>
      <span className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-bg-subtle">
        <span
          ref={barRef}
          className={cn(
            'block h-full w-full origin-left rounded-full',
            stalled ? 'bg-warning' : 'cs-gradient-accent'
          )}
          style={{ transform: 'scaleX(0)' }}
        />
      </span>

      {(offline || slow || stalled) && (
        <div ref={noticeRef} className="overflow-hidden">
          <div
            className={cn(
              'mt-2 rounded-xs px-2.5 py-2 text-micro leading-relaxed',
              offline || stalled ? 'bg-warning-subtle text-warning' : 'bg-bg-subtle text-text-secondary'
            )}
          >
            <p className="flex items-start gap-1.5">
              {offline ? (
                <WifiOff size={12} className="mt-[3px] shrink-0" />
              ) : (
                <Hourglass size={12} className="mt-[3px] shrink-0" />
              )}
              <span className="min-w-0">
                {offline
                  ? t('wait.offline')
                  : stalled
                    ? t(`wait.${kind}_stalled`)
                    : t(`wait.${kind}_slow`)}
              </span>
            </p>
            {stalled && !offline && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={timer.extend}
                  className="inline-flex h-7 items-center rounded-full bg-surface px-2.5 text-micro font-medium text-text shadow-xs ring-1 ring-inset ring-border-faint transition-colors hover:bg-surface-hover"
                >
                  {t('wait.keep_waiting')}
                </button>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="inline-flex h-7 items-center gap-1 rounded-full bg-surface px-2.5 text-micro font-medium text-text shadow-xs ring-1 ring-inset ring-border-faint transition-colors hover:bg-surface-hover"
                  >
                    <RotateCcw size={11} /> {t('wait.retry')}
                  </button>
                )}
                {onStop && (
                  <button
                    type="button"
                    onClick={onStop}
                    className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-micro font-medium text-text-secondary transition-colors hover:bg-surface hover:text-danger"
                  >
                    <Square size={10} /> {t('wait.stop')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
