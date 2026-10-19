import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { useFormatters } from '@/i18n/format'
import { cn } from '@/lib/utils'

/** 慢 / 很慢 两档阈值（秒）：与上游 gpt-image 的常见耗时分布对齐 */
const SLOW_AFTER = 60
const STALLED_AFTER = 180

/** 阶段文案按耗时估算——我们拿不到上游真实进度，所以只说「大概在做什么」，不报假百分比。 */
const STAGES: Array<{ until: number; key: string }> = [
  { until: 4, key: 'queued' },
  { until: 16, key: 'composing' },
  { until: 42, key: 'rendering' },
  { until: Infinity, key: 'finishing' },
]

/**
 * 渐近进度：1 - e^(-t/τ)，上限 94%。
 * 诚实的进度条——越往后走得越慢，永远不会自己走到 100%；
 * 只有结果真的落到画布上，这张卡才会消失。
 */
function estimate(seconds: number) {
  return Math.min(0.94, 1 - Math.exp(-seconds / 24))
}

interface GeneratingCardProps {
  rect: { x: number; y: number; w: number; h: number }
  startedAt: number
  onCancel?: () => Promise<void> | void
}

/**
 * 画布上的「正在生成」占位卡。
 *
 * 视觉：一张显影中的相纸——青柠扫描光带从上往下反复扫过，底部是阶段 + 用时 + 渐近进度条。
 * 超时容错：60s 后提示「比平时慢」，180s 后给出「继续等 / 取消（额度退回）」两个明确出口，
 * 用户永远知道发生了什么、能做什么，而不是对着一个转圈干等。
 * 画布缩得很小时自动切到紧凑形态（只留进度环），避免文字挤成一团。
 */
export function GeneratingCard({ rect, startedAt, onCancel }: GeneratingCardProps) {
  const { t } = useTranslation('stage')
  const fmt = useFormatters()
  const [seconds, setSeconds] = useState(() => (Date.now() - startedAt) / 1000)
  const [dismissedSlow, setDismissedSlow] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const scanRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((Date.now() - startedAt) / 1000), 500)
    return () => window.clearInterval(timer)
  }, [startedAt])

  // 入场 + 扫描光带循环
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      gsap.from(root, { autoAlpha: 0, scale: 0.94, duration: 0.5, ease: 'expo.out' })
      if (scanRef.current) {
        gsap.fromTo(
          scanRef.current,
          { yPercent: -120 },
          { yPercent: 220, duration: 2.2, ease: 'sine.inOut', repeat: -1, repeatDelay: 0.25 }
        )
      }
    }, root)
    return () => ctx.revert()
  }, [])

  const progress = estimate(seconds)
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    if (shouldReduceMotion()) gsap.set(bar, { scaleX: progress })
    else gsap.to(bar, { scaleX: progress, duration: 0.6, ease: 'power2.out', overwrite: 'auto' })
  }, [progress])

  const stage = STAGES.find((item) => seconds < item.until)?.key ?? 'finishing'
  const slow = seconds >= SLOW_AFTER
  const stalled = seconds >= STALLED_AFTER
  const compact = rect.w < 168 || rect.h < 132

  const cancel = async () => {
    if (!onCancel || cancelling) return
    setCancelling(true)
    try {
      await onCancel()
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      aria-label={t(`gen.stage.${stage}`)}
      className="cs-gen-card pointer-events-auto absolute z-10 overflow-hidden rounded-[10px]"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {/* 底：极光 + 网点，像显影液里慢慢浮出来的画面 */}
      <span aria-hidden className="cs-gen-aurora absolute inset-0" />
      <span aria-hidden className="cs-gen-grid absolute inset-0" />
      <span ref={scanRef} aria-hidden className="cs-gen-scan absolute inset-x-0 top-0 h-1/3" />

      {compact ? (
        <div className="relative flex h-full items-center justify-center">
          <ProgressRing value={progress} />
        </div>
      ) : (
        <div className="relative flex h-full flex-col justify-end gap-1.5 p-3">
          {slow && !dismissedSlow && (
            <div className="mb-auto rounded-[8px] bg-surface/90 p-2 text-micro leading-snug text-text-secondary shadow-sheet backdrop-blur">
              <p className="font-medium text-text">
                {stalled ? t('gen.stalled_title') : t('gen.slow_title')}
              </p>
              <p className="mt-0.5">{stalled ? t('gen.stalled_desc') : t('gen.slow_desc')}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setDismissedSlow(true)}
                  className="rounded-full bg-bg-subtle px-2 py-0.5 font-medium text-text hover:bg-surface-hover"
                >
                  {t('gen.keep_waiting')}
                </button>
                {onCancel && (
                  <button
                    type="button"
                    disabled={cancelling}
                    onClick={() => void cancel()}
                    className="rounded-full px-2 py-0.5 font-medium text-danger hover:bg-danger-subtle disabled:opacity-50"
                  >
                    {cancelling ? t('gen.cancelling') : t('gen.cancel_refund')}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inset-0 animate-ping rounded-full bg-accent-strong opacity-60" />
              <span className="relative h-2 w-2 rounded-full bg-accent-strong" />
            </span>
            <span key={stage} className="cs-gen-stage min-w-0 flex-1 truncate text-caption font-medium text-text">
              {t(`gen.stage.${stage}`)}
            </span>
            <span className="shrink-0 text-micro tabular-nums text-text-tertiary">
              {fmt.duration(seconds * 1000)}
            </span>
            {onCancel && !slow && (
              <button
                type="button"
                aria-label={t('gen.cancel_refund')}
                title={t('gen.cancel_refund')}
                disabled={cancelling}
                onClick={() => void cancel()}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-surface hover:text-text disabled:opacity-50"
              >
                {cancelling ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
              </button>
            )}
          </div>
          <span className="relative h-1 w-full overflow-hidden rounded-full bg-text/10">
            <span
              ref={barRef}
              className="cs-gradient-accent absolute inset-0 origin-left rounded-full"
              style={{ transform: 'scaleX(0)' }}
            />
          </span>
        </div>
      )}
    </div>
  )
}

/** 紧凑形态的进度环（SVG stroke-dashoffset）。 */
function ProgressRing({ value }: { value: number }) {
  const r = 14
  const c = 2 * Math.PI * r
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="-rotate-90" aria-hidden>
      <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="3" className="text-text/10" />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke="var(--color-accent-strong)"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        style={{ transition: 'stroke-dashoffset 600ms var(--ease-out)' }}
      />
    </svg>
  )
}
