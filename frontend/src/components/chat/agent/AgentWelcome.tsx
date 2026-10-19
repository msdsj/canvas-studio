import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, CheckCircle2, Layers, ListTree, Wand2 } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { AgentGlyph } from './AgentGlyph'

interface AgentWelcomeProps {
  examples: string[]
  onPick: (text: string) => void
}

const CAPABILITIES = [
  { key: 'cap_plan', icon: ListTree },
  { key: 'cap_skill', icon: Wand2 },
  { key: 'cap_confirm', icon: CheckCircle2 },
  { key: 'cap_canvas', icon: Layers },
] as const

/**
 * 空会话的欢迎区：说清楚「这个 Agent 会怎么工作」，再给几句可以直接点的开场白。
 * 入场用一条 GSAP 时间线：头像落定 → 标题 → 能力标签逐个点亮 → 示例句子升起。
 */
export function AgentWelcome({ examples, onPick }: AgentWelcomeProps) {
  const { t } = useTranslation('agent')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
      tl.from('[data-w="glyph"]', { scale: 0.6, opacity: 0, duration: 0.55, ease: 'back.out(2)' })
        .from('[data-w="text"]', { y: 10, opacity: 0, duration: 0.5, stagger: 0.07 }, '-=0.25')
        .from('[data-w="cap"]', { y: 6, opacity: 0, duration: 0.4, stagger: 0.06 }, '-=0.25')
        .from('[data-w="example"]', { y: 8, opacity: 0, duration: 0.42, stagger: 0.07 }, '-=0.2')
    }, root)
    return () => ctx.revert()
  }, [])

  return (
    <div ref={rootRef} className="flex flex-col gap-5 px-1 pb-4 pt-8 sm:pt-12">
      <div className="flex flex-col items-start gap-3">
        <span data-w="glyph" className="inline-flex">
          <AgentGlyph size={40} active />
        </span>
        <p
          data-w="text"
          className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-micro font-medium text-accent-ink"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-accent-strong" />
          {t('empty.eyebrow')}
        </p>
        <h3 data-w="text" className="text-h3 font-semibold tracking-[-0.015em] text-text">
          {t('empty.title')}
        </h3>
        <p data-w="text" className="max-w-[340px] text-caption leading-relaxed text-text-tertiary">
          {t('empty.desc')}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {CAPABILITIES.map(({ key, icon: Icon }) => (
          <span
            key={key}
            data-w="cap"
            className="flex items-center gap-2 rounded-sm bg-bg-subtle/60 px-2.5 py-2 text-caption text-text-secondary ring-1 ring-inset ring-border-faint"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs bg-surface text-accent-ink shadow-xs">
              <Icon size={13} />
            </span>
            <span className="min-w-0 truncate">{t(`empty.${key}`)}</span>
          </span>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <p data-w="text" className="text-micro font-medium uppercase tracking-[0.08em] text-text-faint">
          {t('empty.try')}
        </p>
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            data-w="example"
            onClick={() => onPick(example)}
            className="group/ex flex items-center gap-2 rounded-sm px-2.5 py-2 text-left text-caption text-text-secondary ring-1 ring-inset ring-border-faint transition-[background-color,color,box-shadow] duration-200 hover:bg-accent-soft hover:text-text hover:ring-accent-strong/40"
          >
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{example}</span>
            <ArrowUpRight
              size={14}
              className="shrink-0 text-text-faint transition-transform duration-200 group-hover/ex:-translate-y-0.5 group-hover/ex:translate-x-0.5 group-hover/ex:text-accent-ink"
            />
          </button>
        ))}
      </div>
    </div>
  )
}
