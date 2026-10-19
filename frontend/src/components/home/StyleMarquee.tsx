import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkle } from 'lucide-react'
import { gsap, ScrollTrigger } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

/**
 * 风格关键词跑马灯：两行反向滚动，滚动页面时顺势加速（速度跟随滚动方向与快慢）。
 *
 * 实现要点：
 * - 每行内容复制一份首尾相接，xPercent 从 0 走到 -50 再无缝回到 0；
 * - 外层 overflow-hidden + 两端渐隐遮罩，任何宽度都不会撑出横向滚动条；
 * - 页面滚动时用 timeScale 叠加速度，停下后 0.8s 内回落到巡航速度，像有惯性。
 */
export function StyleMarquee() {
  const { t } = useTranslation('home')
  const rows = t('marquee.rows', { returnObjects: true }) as string[][]
  const rootRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      const tracks = gsap.utils.toArray<HTMLElement>('[data-track]', root)
      const loops = tracks.map((track, index) =>
        gsap.fromTo(
          track,
          { xPercent: index % 2 === 0 ? 0 : -50 },
          { xPercent: index % 2 === 0 ? -50 : 0, duration: 38 + index * 6, ease: 'none', repeat: -1 }
        )
      )
      const boost = { v: 1 }
      ScrollTrigger.create({
        trigger: root,
        start: 'top bottom',
        end: 'bottom top',
        onToggle: (self) => loops.forEach((loop) => (self.isActive ? loop.play() : loop.pause())),
        onUpdate: (self) => {
          const v = 1 + Math.min(Math.abs(self.getVelocity()) / 400, 4)
          gsap.to(boost, {
            v,
            duration: 0.2,
            overwrite: true,
            onUpdate: () => loops.forEach((loop) => loop.timeScale(boost.v)),
            onComplete: () => {
              gsap.to(boost, {
                v: 1,
                duration: 0.8,
                ease: 'power2.out',
                onUpdate: () => loops.forEach((loop) => loop.timeScale(boost.v)),
              })
            },
          })
        },
      })
    }, root)
    return () => ctx.revert()
  }, [rows.length])

  return (
    <div
      ref={rootRef}
      aria-label={t('marquee.label')}
      className="cs-marquee relative z-10 flex flex-col gap-3 overflow-hidden py-6 sm:py-10"
    >
      {rows.map((row, index) => (
        <div key={index} className="flex w-full overflow-hidden">
          <div data-track className="flex w-max shrink-0">
            {[0, 1].map((copy) => (
              <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0 items-center">
                {row.map((word) => (
                  <li
                    key={word}
                    className={
                      index % 2 === 0
                        ? 'flex items-center gap-4 pr-4 font-display text-[26px] tracking-[-0.02em] text-text sm:text-[40px]'
                        : 'flex items-center gap-4 pr-4 font-display text-[26px] tracking-[-0.02em] text-text-faint sm:text-[40px]'
                    }
                  >
                    {word}
                    <Sparkle size={16} className="shrink-0 text-accent-strong" aria-hidden />
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
