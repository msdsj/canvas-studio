import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lightbulb, X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface PromptGuideProps {
  value: string
  onChange: (next: string) => void
  /** 已带参考图 / @ 引用时需求通常已经够具体（「照这张改」），不再打扰 */
  hasReferences?: boolean
}

type GroupKey = 'usage' | 'style' | 'ratio'

const GROUPS: Array<{ key: GroupKey; options: string[] }> = [
  { key: 'usage', options: ['poster', 'social', 'ecommerce', 'avatar', 'banner'] },
  { key: 'style', options: ['minimal', 'guochao', 'cyber', 'film', 'illustration', '3d'] },
  { key: 'ratio', options: ['1_1', '3_4', '16_9', '9_16'] },
]

/** 判定为「需求还很模糊」的阈值：太短，或者只有主体、没有任何用途/风格/比例信息 */
const VAGUE_MAX_LENGTH = 14

/**
 * 「帮你补全需求」引导：输入很短、信息不全时，在输入框上方给三组一键补充项。
 *
 * 设计取舍：
 * - **只引导、不拦截**：任何时候都能直接发送，引导条不是表单；
 * - 每组单选：点另一个选项会替换本组已插入的片段，而不是越堆越长；
 *   再点一次已选项 = 撤销；
 * - 片段是自然语言（「，用作电商主图」），发出去的仍是一句人话，
 *   后端的需求分析不需要为它做任何特殊解析；
 * - 关掉后，本次输入清空前不再出现。
 */
export function PromptGuide({ value, onChange, hasReferences = false }: PromptGuideProps) {
  const { t } = useTranslation('agent')
  const [dismissed, setDismissed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const trimmed = value.trim()
  // 输入清空 = 开始一句新需求：之前的「关闭」不再生效
  if (dismissed && trimmed.length === 0) setDismissed(false)

  const segmentOf = (group: GroupKey, option: string) => t(`guide.${group}.${option}.insert`)
  const pickedIn = (group: GroupKey) =>
    GROUPS.find((item) => item.key === group)?.options.find((option) =>
      value.includes(segmentOf(group, option))
    ) ?? null

  const anyPicked = GROUPS.some((group) => pickedIn(group.key))
  const vague = trimmed.length > 0 && (trimmed.length < VAGUE_MAX_LENGTH || anyPicked)
  const visible = vague && !dismissed && !hasReferences

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || !visible || shouldReduceMotion()) return
    const tl = gsap.timeline()
    tl.fromTo(
      root,
      { height: 0, opacity: 0 },
      { height: 'auto', opacity: 1, duration: 0.42, ease: 'power3.out', clearProps: 'height' }
    )
    tl.fromTo(
      root.querySelectorAll('[data-guide-chip]'),
      { opacity: 0, y: 4 },
      { opacity: 1, y: 0, duration: 0.3, stagger: 0.018, ease: 'power2.out', clearProps: 'transform' },
      0.12
    )
    return () => {
      tl.kill()
    }
  }, [visible])

  if (!visible) return null

  const toggle = (group: GroupKey, option: string) => {
    const current = pickedIn(group)
    let next = value
    if (current) next = next.replace(segmentOf(group, current), '')
    if (current !== option) next = `${next.replace(/\s+$/, '')}${segmentOf(group, option)}`
    onChange(next)
  }

  return (
    <div ref={rootRef} className="overflow-hidden">
      <div className="mb-1.5 rounded-md bg-surface/90 px-2.5 py-2 shadow-xs ring-1 ring-inset ring-border-faint backdrop-blur">
        <div className="flex items-center gap-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
            <Lightbulb size={11} />
          </span>
          <p className="min-w-0 flex-1 truncate text-micro font-medium text-text-secondary">
            {t('guide.title')}
          </p>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label={t('guide.dismiss')}
            title={t('guide.dismiss')}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-faint transition-colors hover:bg-surface-hover hover:text-text"
          >
            <X size={12} />
          </button>
        </div>
        <div className="mt-1.5 flex flex-col gap-1">
          {GROUPS.map((group) => {
            const picked = pickedIn(group.key)
            return (
              <div key={group.key} className="flex min-w-0 items-center gap-1.5">
                <span className="w-8 shrink-0 text-micro text-text-tertiary">
                  {t(`guide.${group.key}.label`)}
                </span>
                <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
                  {group.options.map((option) => {
                    const active = picked === option
                    return (
                      <button
                        key={option}
                        type="button"
                        data-guide-chip
                        aria-pressed={active}
                        onClick={() => toggle(group.key, option)}
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-micro transition-colors duration-200',
                          active
                            ? 'bg-accent text-on-accent'
                            : 'bg-bg-subtle text-text-secondary hover:bg-accent-soft hover:text-text'
                        )}
                      >
                        {t(`guide.${group.key}.${option}.label`)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
