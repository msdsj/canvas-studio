import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { gsap, ScrollTrigger } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

interface StatItem {
  value: number
  suffix: string
  label: string
  desc: string
}

/**
 * 数字条：只放**产品事实**（技能数、场景数、工作流步数、失败退还），
 * 不放无法核实的用户量 / 满意度——首页上的假数字比没有数字更伤信任。
 *
 * 滚到时数字从 0 滚到目标值（textContent 直写，不触发 React 渲染），
 * 千分位按当前语言格式化。
 */
export function StatsStrip() {
  const { t, i18n } = useTranslation('home')
  const items = t('stats.items', { returnObjects: true }) as StatItem[]
  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const fmt = new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language)
    const nums = Array.from(root.querySelectorAll<HTMLElement>('[data-num]'))
    if (shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      nums.forEach((el) => (el.textContent = fmt.format(0)))
      ScrollTrigger.create({
        trigger: root,
        start: 'top 85%',
        once: true,
        onEnter: () => {
          nums.forEach((el, index) => {
            const target = Number(el.dataset.num) || 0
            const counter = { n: 0 }
            gsap.to(counter, {
              n: target,
              duration: 1.4,
              delay: index * 0.12,
              ease: 'power3.out',
              onUpdate: () => (el.textContent = fmt.format(Math.round(counter.n))),
            })
          })
          gsap.from(root.querySelectorAll('[data-stat]'), { y: 18, opacity: 0, duration: 0.6, stagger: 0.1, ease: 'csPaper' })
        },
      })
    }, root)
    return () => ctx.revert()
  }, [i18n.language, i18n.resolvedLanguage, items.length])

  return (
    <section className="relative z-10 mx-auto w-full max-w-[1180px] px-4 sm:px-8">
      <div
        ref={rootRef}
        className="grid grid-cols-2 overflow-hidden rounded-[22px] bg-surface/80 shadow-sheet ring-1 ring-border-faint backdrop-blur lg:grid-cols-4"
      >
        {items.map((item, index) => (
          <div
            key={item.label}
            data-stat
            className={
              'flex flex-col gap-1 p-5 sm:p-7 ' +
              (index % 2 === 1 ? 'border-l border-border-faint ' : '') +
              (index >= 2 ? 'border-t border-border-faint lg:border-t-0 ' : '') +
              (index === 2 ? 'lg:border-l' : '')
            }
          >
            <p className="flex items-baseline gap-0.5 font-display text-[36px] leading-none tracking-[-0.03em] text-text sm:text-[48px]">
              <span data-num={item.value} className="tabular-nums">
                {item.value}
              </span>
              <span className="text-[22px] text-accent-strong sm:text-[28px]">{item.suffix}</span>
            </p>
            <p className="mt-2 text-caption font-semibold text-text">{item.label}</p>
            <p className="text-micro leading-relaxed text-text-tertiary">{item.desc}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
