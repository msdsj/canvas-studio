import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Frame, MousePointerClick, Sparkles, X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

const STORAGE_KEY = 'cs.editCoach.v1'

function readSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

const STEPS = [
  { icon: Frame, key: 'frame' },
  { icon: MousePointerClick, key: 'describe' },
  { icon: Sparkles, key: 'submit' },
] as const

/**
 * 首次进入编辑模式的三步引导：框选 → 写怎么改 → 提交。
 *
 * 只出现一次（localStorage 记住），用户一旦开始画（hidden 变 true）也自动收起——
 * 引导的目的是让人「开始动手」，人已经动手了就别挡着。
 * 贴在图片下方而不是盖在图上，画框的手不会被它挡住。
 */
export function EditCoach({ hidden, style }: { hidden: boolean; style: React.CSSProperties }) {
  const { t } = useTranslation('edit')
  const [open, setOpen] = useState(() => !readSeen())
  const rootRef = useRef<HTMLDivElement>(null)

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      /* ignore */
    }
    const root = rootRef.current
    if (!root || shouldReduceMotion()) {
      setOpen(false)
      return
    }
    gsap.to(root, { autoAlpha: 0, y: 8, duration: 0.22, ease: 'power2.in', onComplete: () => setOpen(false) })
  }

  // 用户已经开始画了：视为学会，静默记住
  useLayoutEffect(() => {
    if (hidden && open) dismiss()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!open || !root || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      gsap
        .timeline({ delay: 0.25 })
        .from(root, { autoAlpha: 0, y: 12, duration: 0.45, ease: 'power3.out' })
        .from('[data-coach-step]', { autoAlpha: 0, x: -8, stagger: 0.09, duration: 0.35, ease: 'power2.out' }, '-=0.2')
    }, root)
    return () => ctx.revert()
  }, [open])

  if (!open) return null

  // 外层只负责定位（沿用调用方的 left/top/transform），内层交给 GSAP 做入场/退场：
  // 两者分开，GSAP 写的 transform 才不会把定位用的 translate 覆盖掉
  return (
    <div className="pointer-events-none absolute z-40 w-[min(340px,calc(100%-16px))]" style={style}>
    <div
      ref={rootRef}
      data-edit-surface="coach"
      role="dialog"
      aria-label={t('coach.title')}
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-auto rounded-[16px] bg-surface-raised p-3 shadow-float ring-1 ring-border-faint"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-caption font-semibold text-text">{t('coach.title')}</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('coach.dismiss')}
          className="flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <X size={13} />
        </button>
      </div>
      <ol className="flex flex-col gap-1.5">
        {STEPS.map((step, index) => {
          const Icon = step.icon
          return (
            <li key={step.key} data-coach-step className="flex items-start gap-2">
              <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
                <Icon size={12} />
              </span>
              <div className="min-w-0">
                <p className="text-micro font-semibold text-text">
                  {index + 1}. {t(`coach.${step.key}.title`)}
                </p>
                <p className="text-micro leading-snug text-text-tertiary">{t(`coach.${step.key}.desc`)}</p>
              </div>
            </li>
          )
        })}
      </ol>
      <button
        type="button"
        onClick={dismiss}
        className="mt-2.5 h-7 w-full rounded-full bg-brand text-micro font-semibold text-text-inverse transition-[filter] hover:brightness-110"
      >
        {t('coach.got_it')}
      </button>
    </div>
    </div>
  )
}
