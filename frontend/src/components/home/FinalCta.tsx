import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, ArrowUp } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { useScrollReveal } from '@/lib/motion'
import { ArtImage } from './ArtImage'
import { useVisibleLoop } from './use-visible-loop'

/** 公转作品环：用真实作品缩略图，比抽象色块更像「这里真的产出过东西」 */
const ORBIT = [
  '/generated/gallery-tech.jpg',
  '/generated/gallery-camping.jpg',
  '/generated/gallery-festival.jpg',
  '/generated/gallery-perfume.jpg',
  '/generated/gallery-skincare.jpg',
  '/generated/gallery-mountain.jpg',
]

/**
 * 收尾 CTA：墨色大卡 + 一圈缓慢公转的作品缩略图 + 一个「假输入框」。
 *
 * 假输入框不是装饰：点它会滚回首屏并聚焦真输入框——
 * 滚到底的人往往已经被说服，只差一个顺手的入口，不该让他们自己再往回找。
 */
export function FinalCta({ onStart, onCompose }: { onStart: () => void; onCompose: () => void }) {
  const { t } = useTranslation('home')
  const rootRef = useRef<HTMLDivElement>(null)

  useScrollReveal(rootRef, { selector: '[data-cta]', y: 26, stagger: 0.08 })

  useVisibleLoop(rootRef, (root) => {
    const ring = root.querySelector('[data-orbit]')
    const thumbs = root.querySelectorAll('[data-thumb]')
    if (!ring) return null
    const tl = gsap.timeline({ repeat: -1 })
    tl.to(ring, { rotation: 360, duration: 60, ease: 'none' }, 0)
    // 缩略图反向自转，抵消公转带来的倾斜，让图片始终「正着」
    tl.to(thumbs, { rotation: -360, duration: 60, ease: 'none' }, 0)
    return tl
  })

  return (
    <section className="relative z-10 mx-auto w-full max-w-[1180px] px-4 pb-16 sm:px-8 sm:pb-24">
      <div
        ref={rootRef}
        className="relative overflow-hidden rounded-[28px] bg-brand px-5 py-14 text-center text-text-inverse shadow-drag sm:px-10 sm:py-20"
      >
        <div aria-hidden className="pointer-events-none absolute -top-28 left-1/2 h-64 w-[80%] -translate-x-1/2 rounded-full bg-accent/35 blur-[100px]" />

        {/* 公转作品环：只在 ≥sm 显示，窄屏把空间让给文字与按钮 */}
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 hidden h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 opacity-60 sm:block lg:h-[820px] lg:w-[820px]">
          <div data-orbit className="relative h-full w-full rounded-full border border-dashed border-text-inverse/15">
            {ORBIT.map((src, index) => {
              const angle = (index / ORBIT.length) * Math.PI * 2
              return (
                <div
                  key={src}
                  data-thumb
                  className="absolute h-[var(--th)] w-[var(--th)] overflow-hidden rounded-[14px] shadow-float [--th:64px] lg:[--th:80px]"
                  style={{
                    // 用 left/top 定位而不是 translate：translate 会和 GSAP 的自转 transform 打架
                    left: `calc(50% + ${Math.cos(angle) * 50}% - var(--th) / 2)`,
                    top: `calc(50% + ${Math.sin(angle) * 50}% - var(--th) / 2)`,
                  }}
                >
                  <ArtImage src={src} alt="" className="h-full w-full" />
                </div>
              )
            })}
          </div>
        </div>

        <div className="relative">
          <p data-cta className="text-micro font-semibold uppercase tracking-[0.16em] text-text-inverse/60">
            {t('cta.eyebrow')}
          </p>
          <h2 data-cta className="mx-auto mt-4 max-w-[640px] font-display text-[32px] leading-[1.1] tracking-[-0.02em] sm:text-[52px]">
            {t('cta.title')}
          </h2>
          <p data-cta className="mx-auto mt-4 max-w-[460px] text-ui leading-relaxed text-text-inverse/70">
            {t('cta.subtitle')}
          </p>

          <button
            data-cta
            type="button"
            onClick={onCompose}
            className="group mx-auto mt-8 flex w-full max-w-[520px] items-center gap-3 rounded-full bg-surface p-1.5 pl-5 text-left shadow-float ring-1 ring-border-faint transition-transform duration-300 hover:-translate-y-0.5"
          >
            <span className="min-w-0 flex-1 truncate text-ui text-text-faint">{t('cta.placeholder')}</span>
            <span className="cs-gradient-accent flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-glow transition-transform duration-300 group-hover:-rotate-12">
              <ArrowUp size={18} strokeWidth={2.4} />
            </span>
          </button>

          <button
            data-cta
            type="button"
            onClick={onStart}
            className="mt-5 inline-flex items-center gap-1.5 text-caption font-medium text-text-inverse/80 underline-offset-4 transition-colors hover:text-text-inverse hover:underline"
          >
            {t('cta.button')}
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </section>
  )
}
