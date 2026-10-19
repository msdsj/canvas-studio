import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check, LayoutTemplate, Sparkles, Wand2, Puzzle } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

const STEPS = [
  { key: 'understand', icon: Brain },
  { key: 'plan', icon: LayoutTemplate },
  { key: 'skill', icon: Puzzle },
  { key: 'generate', icon: Sparkles },
  { key: 'refine', icon: Wand2 },
] as const

/** 打字时混进来的"解码字符"：让文本像是 Agent 实时推理出来的，而不是贴上去的 */
const GLYPHS = '▪▫◇◆·:/<>+*'
/** 每一步停留时长（秒）：打字约 0.6s + 阅读 2.2s */
const HOLD = 2.2

/**
 * Agent 工作流状态条：在首页循环演示「理解 → 规划 → 技能 → 生成 → 精修」。
 *
 * 每一步做三件事，串在同一条 timeline 上，节奏才不会散：
 *  1. 上一步的标题向上淡出、新标题从下方升起；
 *  2. 说明文字以"解码"方式逐字显现（前沿几位是随机字符，后面是定稿文字）；
 *  3. 底部对应格子的进度条从 0 走到 1，走满即切到下一步。
 *
 * 文本写入用 textContent 直接改 DOM，不经过 React state：每帧 setState
 * 会让整个状态条 60fps 重渲染，这是首页最容易掉帧的地方。
 */
export function AgentWorkflowStrip({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('home')
  const [active, setActive] = useState(0)
  const titleRef = useRef<HTMLSpanElement>(null)
  const detailRef = useRef<HTMLSpanElement>(null)
  const barsRef = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    const title = titleRef.current
    const detail = detailRef.current
    if (!title || !detail) return

    const step = STEPS[active]
    const titleText = t(`workflow.steps.${step.key}.title`)
    const detailText = t(`workflow.steps.${step.key}.detail`)
    const bar = barsRef.current[active]
    const next = () => setActive((index) => (index + 1) % STEPS.length)

    // 进度格的状态完全由 GSAP 管（不用 class）：已走过的满格、其余清零。
    // 放在 context 之外，cleanup 的 revert 不会把它撤掉
    barsRef.current.forEach((item, index) => {
      if (item) gsap.set(item, { scaleX: index < active ? 1 : 0 })
    })

    if (shouldReduceMotion()) {
      title.textContent = titleText
      detail.textContent = detailText
      if (bar) gsap.set(bar, { scaleX: 1 })
      const timer = window.setTimeout(next, (HOLD + 0.8) * 1000)
      return () => window.clearTimeout(timer)
    }

    const ctx = gsap.context(() => {
      const progress = { p: 0 }
      const tl = gsap.timeline({ onComplete: next })
      tl.fromTo(
        title,
        { yPercent: 60, opacity: 0 },
        {
          yPercent: 0,
          opacity: 1,
          duration: 0.42,
          ease: 'csPaper',
          onStart: () => {
            title.textContent = titleText
          },
        }
      )
        .to(
          progress,
          {
            p: 1,
            duration: Math.min(0.9, 0.18 + detailText.length * 0.022),
            ease: 'none',
            onUpdate: () => {
              const shown = Math.floor(progress.p * detailText.length)
              // 前沿 3 个字符用随机符号顶着，读起来像"正在解码"
              const tail = Array.from({ length: Math.min(3, detailText.length - shown) }, () =>
                GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length))
              ).join('')
              detail.textContent = detailText.slice(0, shown) + tail
            },
            onComplete: () => {
              detail.textContent = detailText
            },
          },
          0.1
        )
        .fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: HOLD + 0.5, ease: 'none' }, 0)
        .to(title, { yPercent: -50, opacity: 0, duration: 0.3, ease: 'power2.in' }, `+=0.05`)
        .to(detail, { opacity: 0, duration: 0.24, ease: 'power2.in' }, '<')
        .set(detail, { opacity: 1 })
    })
    return () => ctx.revert()
    // 语言切换时重放当前一步，避免中英文混排
  }, [active, t, i18n.language])

  const Icon = STEPS[active].icon

  return (
    <div
      className={cn(
        'cs-glass flex w-full items-center gap-3 rounded-full px-2 py-1.5 shadow-sheet ring-1 ring-inset ring-border-faint',
        className
      )}
      role="status"
      aria-live="off"
    >
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/50 [animation-duration:2.4s]" />
        <Icon size={14} className="relative" strokeWidth={2.2} />
      </span>

      <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="hidden shrink-0 text-micro text-text-tertiary sm:inline">
          {t('workflow.status')}
        </span>
        <span
          ref={titleRef}
          className="shrink-0 text-caption font-semibold text-text will-change-transform"
        />
        <span
          ref={detailRef}
          className="min-w-0 truncate font-mono text-micro text-text-tertiary sm:font-sans"
        />
      </div>

      {/* 五格进度：已完成的格子留对勾，当前格走进度条 */}
      <div className="hidden shrink-0 items-center gap-1 pr-1.5 md:flex">
        {STEPS.map((step, index) => (
          <span
            key={step.key}
            title={t(`workflow.steps.${step.key}.title`)}
            className="relative flex h-1.5 w-6 overflow-hidden rounded-full bg-border"
          >
            <span
              ref={(el) => {
                barsRef.current[index] = el
              }}
              className="absolute inset-0 origin-left rounded-full bg-accent-strong"
              // 首帧先收起，避免 effect 接管前五格都是满的；之后 React 不会再改写它
              style={{ transform: 'scaleX(0)' }}
            />
          </span>
        ))}
        {active === STEPS.length - 1 && (
          <Check size={12} className="ml-0.5 text-accent-strong" strokeWidth={3} />
        )}
      </div>
    </div>
  )
}
