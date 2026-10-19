import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { BrainCircuit, MessagesSquare, Scan } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { ChatToCanvasDemo, DecomposeDemo, RegionEditDemo } from './StoryDemos'
import { asList } from '@/i18n'

const CHAPTERS = [
  { key: 'chat', icon: MessagesSquare, Demo: ChatToCanvasDemo },
  { key: 'region', icon: Scan, Demo: RegionEditDemo },
  { key: 'decompose', icon: BrainCircuit, Demo: DecomposeDemo },
] as const

/**
 * 三大核心亮点的「滚动叙事」。
 *
 * 桌面端（≥md 且允许动效）：整段钉住，滚动驱动三章依次切换——
 * 左边文字上推淡出、右边演示缩放交接，左侧进度轨同步填充，并吸附到每一章。
 * 用 CSS grid 的同格叠放（display: contents + grid-area 1/1）实现「三章叠在同一位置」，
 * 而不是绝对定位：容器高度仍由内容决定，不需要再手算。
 *
 * 移动端 / 减弱动效：不钉住，三章按「文字 → 演示」顺序自然往下排。
 * 两种形态共用同一份 DOM，只靠 data-pinned 切换布局，演示的循环动画只有一份。
 */
export function ShowcaseStory() {
  const { t } = useTranslation('home')
  const rootRef = useRef<HTMLElement>(null)
  const pinRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    const pin = pinRef.current
    if (!root || !pin) return
    const mm = gsap.matchMedia()

    mm.add('(min-width: 768px)', () => {
      if (shouldReduceMotion()) return
      root.dataset.pinned = 'true'
      const q = gsap.utils.selector(root)
      const texts = q('[data-story-text]')
      const demos = q('[data-story-demo]')
      const marks = q('[data-story-mark]')
      const n = texts.length

      gsap.set(texts.slice(1), { autoAlpha: 0, y: 48 })
      gsap.set(demos.slice(1), { autoAlpha: 0, y: 40, scale: 0.94 })
      gsap.set(marks.slice(1), { opacity: 0.35 })

      const tl = gsap.timeline({
        defaults: { ease: 'power2.inOut', duration: 1 },
        scrollTrigger: {
          trigger: pin,
          start: 'center center',
          end: () => `+=${window.innerHeight * (n - 0.4)}`,
          pin: true,
          scrub: 0.7,
          snap: { snapTo: 1 / (n - 1), duration: { min: 0.25, max: 0.7 }, ease: 'power1.inOut' },
          invalidateOnRefresh: true,
        },
      })
      tl.to(q('[data-story-fill]'), { scaleY: 1, ease: 'none', duration: n - 1 }, 0)
      for (let i = 1; i < n; i += 1) {
        const at = i - 1
        tl.to(texts[i - 1], { autoAlpha: 0, y: -48 }, at)
          .to(demos[i - 1], { autoAlpha: 0, y: -30, scale: 1.04 }, at)
          .to(texts[i], { autoAlpha: 1, y: 0 }, at + 0.25)
          .to(demos[i], { autoAlpha: 1, y: 0, scale: 1 }, at + 0.2)
          .to(marks[i - 1], { opacity: 0.35, duration: 0.3 }, at + 0.2)
          .to(marks[i], { opacity: 1, duration: 0.3 }, at + 0.3)
      }

      return () => {
        delete root.dataset.pinned
      }
    })

    return () => mm.revert()
  }, [t])

  return (
    <section ref={rootRef} id="highlights" className="cs-story relative z-10 mx-auto w-full max-w-[1180px] scroll-mt-20 px-4 py-16 sm:px-8 sm:py-24">
      <div className="text-center">
        <p className="text-micro font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          {t('story.eyebrow')}
        </p>
        <h2 className="mx-auto mt-3 max-w-[680px] font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-text sm:text-[42px]">
          {t('story.title')}
        </h2>
      </div>

      <div ref={pinRef} className="relative mt-10 md:mt-14">
        {/* 进度轨（仅钉住形态可见）：三章的标记 + 随滚动填充的青柠线 */}
        <div className="cs-story-rail pointer-events-none absolute -left-2 top-1/2 hidden h-48 w-px -translate-y-1/2 bg-border lg:-left-6">
          <span data-story-fill className="absolute inset-0 origin-top scale-y-0 bg-accent-strong" />
          {CHAPTERS.map((chapter, index) => (
            <span
              key={chapter.key}
              data-story-mark
              className="absolute -left-[3px] h-[7px] w-[7px] rounded-full bg-accent-strong"
              style={{ top: `${(index / (CHAPTERS.length - 1)) * 100}%` }}
            />
          ))}
        </div>

        <div className="cs-story-track flex flex-col gap-14">
          {CHAPTERS.map((chapter, index) => {
            const Icon = chapter.icon
            const bullets = asList(t(`story.${chapter.key}.bullets`, { returnObjects: true }))
            return (
              <div key={chapter.key} className="cs-story-chapter grid items-center gap-6 md:grid-cols-2 md:gap-12">
                <div data-story-text className="max-w-[460px]">
                  <span className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-2.5 py-1 text-micro font-semibold text-accent-ink">
                    <Icon size={13} />
                    {String(index + 1).padStart(2, '0')} · {t(`story.${chapter.key}.tag`)}
                  </span>
                  <h3 className="mt-4 font-display text-[28px] leading-[1.15] tracking-[-0.02em] text-text sm:text-[36px]">
                    {t(`story.${chapter.key}.title`)}
                  </h3>
                  <p className="mt-3 text-ui leading-relaxed text-text-secondary">
                    {t(`story.${chapter.key}.desc`)}
                  </p>
                  <ul className="mt-5 flex flex-col gap-2">
                    {bullets.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-caption text-text-secondary">
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div data-story-demo className="w-full">
                  <chapter.Demo />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
