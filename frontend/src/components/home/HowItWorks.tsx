import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Boxes,
  Brain,
  Infinity as InfinityIcon,
  LayoutGrid,
  MessageSquareText,
  MoonStar,
  Puzzle,
  RefreshCcw,
  Scan,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useScrollReveal } from '@/lib/motion'

const STEP_ICONS = [MessageSquareText, Brain, Sparkles, RefreshCcw]
const CAPABILITY_ICONS = [InfinityIcon, Puzzle, Scan, ShieldCheck, Boxes, MoonStar]

interface TextItem {
  title: string
  desc: string
}

/**
 * 「Agent 怎么工作」+ 能力格（收尾 CTA 已独立为 FinalCta）。
 *
 * 首页的主角是输入框，这一段只做补充说明，所以刻意做得轻：
 * 没有大图、没有特性墙，滚到时由 ScrollTrigger 依次浮现（once，回滚不重播）。
 */
export function HowItWorks() {
  const { t } = useTranslation('home')
  const stepsRef = useRef<HTMLOListElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useScrollReveal(stepsRef, { selector: '[data-step]', y: 28, stagger: 0.09 })
  useScrollReveal(gridRef, { selector: '[data-cap]', y: 22, stagger: 0.06 })

  const steps = t('how.steps', { returnObjects: true }) as TextItem[]
  const capabilities = t('capabilities.items', { returnObjects: true }) as TextItem[]

  return (
    <section className="relative z-10 mx-auto w-full max-w-[1180px] px-4 py-16 sm:px-8 sm:py-24">
      <div id="how" className="scroll-mt-20 text-center">
        <p className="text-micro font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          {t('how.eyebrow')}
        </p>
        <h2 className="mx-auto mt-3 max-w-[640px] font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-text sm:text-[40px]">
          {t('how.title')}
        </h2>
        <p className="mx-auto mt-3 max-w-[520px] text-ui leading-relaxed text-text-secondary">
          {t('how.subtitle')}
        </p>
      </div>

      {/* 四步流程：桌面端一行四格，中间用虚线串起来；移动端两列/单列 */}
      <ol ref={stepsRef} className="relative mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <span
          aria-hidden
          className="pointer-events-none absolute left-[12%] right-[12%] top-[34px] hidden border-t border-dashed border-border-strong lg:block"
        />
        {steps.map((step, index) => {
          const Icon = STEP_ICONS[index % STEP_ICONS.length]
          return (
            <li
              key={step.title}
              data-step
              className="relative rounded-[18px] border border-border/70 bg-surface/80 p-4 shadow-sheet backdrop-blur"
            >
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-accent text-on-accent shadow-glow">
                  <Icon size={16} />
                </span>
                <span className="font-mono text-micro text-text-faint">0{index + 1}</span>
              </div>
              <p className="mt-3 text-ui font-semibold text-text">{step.title}</p>
              <p className="mt-1 text-caption leading-relaxed text-text-tertiary">{step.desc}</p>
            </li>
          )
        })}
      </ol>

      <div id="capabilities" className="mt-20 scroll-mt-20">
        <h3 className="flex items-center justify-center gap-2 text-center text-h3 font-semibold tracking-[-0.01em] text-text">
          <LayoutGrid size={18} className="text-text-tertiary" />
          {t('capabilities.title')}
        </h3>
        <div ref={gridRef} className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((item, index) => {
            const Icon = CAPABILITY_ICONS[index % CAPABILITY_ICONS.length]
            return (
              <div
                key={item.title}
                data-cap
                data-motion="row"
                className="group flex items-start gap-3 rounded-[16px] border border-border/60 bg-surface/60 p-4 backdrop-blur transition-colors hover:bg-surface"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-accent-soft text-accent-ink transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105">
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-ui font-semibold text-text">{item.title}</p>
                  <p className="mt-0.5 text-caption leading-relaxed text-text-tertiary">{item.desc}</p>
                </div>
              </div>
            )
          })}
        </div>
      </div>

    </section>
  )
}
