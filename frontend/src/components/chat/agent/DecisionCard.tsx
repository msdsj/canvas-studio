import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { AgentGlyph } from './AgentGlyph'

export type DecisionTone = 'pending' | 'choosing' | 'done' | 'voided'

interface DecisionCardProps {
  tone: DecisionTone
  /** 状态行：「已暂停，等你选择」/「已按你的选择开始生成」… */
  status: string
  /** 主问题（模型的结论 / 需要用户决定的事） */
  title?: string
  /** 判定依据：证明不是随口一问 */
  reason?: ReactNode
  /** 标题行右侧的附加信息（规则标签等） */
  meta?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
  runId?: string
  busy?: boolean
}

/**
 * 决策卡外壳：澄清卡 / 数量确认卡 / 选区分析卡共用。
 *
 * 层级固定为：状态 → 问题 → 依据 → 方案 → 主按钮，三种卡看起来是同一种「Agent 停下来问你」。
 * 待选态左侧一条青柠竖线 + 头像光环，明确「流程停在这里」；完成态收成安静的纸面卡。
 */
export function DecisionCard({
  tone,
  status,
  title,
  reason,
  meta,
  children,
  footer,
  className,
  runId,
  busy,
}: DecisionCardProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const waiting = tone === 'pending' || tone === 'choosing'

  // 首次出现：从下方轻轻落位，提示「这里需要你」
  useEffect(() => {
    const el = rootRef.current
    if (!el || shouldReduceMotion()) return
    const tween = gsap.from(el, { opacity: 0, y: 8, scale: 0.985, duration: 0.5, ease: 'power3.out', clearProps: 'all' })
    return () => {
      tween.kill()
    }
  }, [])

  return (
    <div
      ref={rootRef}
      data-run-id={runId}
      aria-busy={busy}
      className={cn(
        'relative overflow-hidden rounded-md bg-surface p-3 shadow-sheet ring-1 ring-inset',
        waiting ? 'ring-accent-strong/40' : 'ring-border-faint',
        tone === 'voided' && 'opacity-60',
        className
      )}
    >
      {waiting && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-accent-strong" />
      )}
      <div className="flex items-start gap-2.5">
        <AgentGlyph size={20} active={tone === 'choosing'} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {waiting && (
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="absolute h-1.5 w-1.5 animate-ping rounded-full bg-accent-strong opacity-70" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-accent-strong" />
              </span>
            )}
            <p
              className={cn(
                'min-w-0 flex-1 truncate text-micro font-medium',
                waiting ? 'text-accent-ink' : tone === 'done' ? 'text-success' : 'text-text-tertiary'
              )}
            >
              {status}
            </p>
            {meta}
          </div>
          {title && (
            <p className="mt-1 text-ui font-semibold leading-snug text-text [overflow-wrap:anywhere]">
              {title}
            </p>
          )}
          {reason && (
            <div className="mt-1 text-caption leading-relaxed text-text-tertiary [overflow-wrap:anywhere]">
              {reason}
            </div>
          )}
        </div>
      </div>

      {children && <div className="mt-3">{children}</div>}
      {footer && <div className="mt-3 flex flex-wrap items-center gap-2">{footer}</div>}
    </div>
  )
}

interface DecisionOptionsProps<T extends { id: string }> {
  options: T[]
  value: string | null
  onChange: (id: string) => void
  disabled?: boolean
  label: string
  renderOption: (option: T, state: { index: number; selected: boolean }) => {
    title: ReactNode
    description?: ReactNode
    badges?: ReactNode
    leading?: ReactNode
    /** 视觉上与上方方案隔开（如「直接用原话」这种退出项） */
    separated?: boolean
  }
}

/**
 * 方案单选组（WAI-ARIA radiogroup）。
 *
 * - 点击 / 空格 / 回车：只选中，不执行（执行永远由主按钮触发，避免误扣额度）；
 * - ↑↓←→：在方案间移动并选中（radio 的标准行为）；
 * - 选中时序号徽标弹一下、卡片底色渐入（GSAP），让「选中了」有确定的手感。
 */
export function DecisionOptions<T extends { id: string }>({
  options,
  value,
  onChange,
  disabled,
  label,
  renderOption,
}: DecisionOptionsProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null)
  const prevValue = useRef(value)

  useEffect(() => {
    if (prevValue.current === value) return
    prevValue.current = value
    const group = groupRef.current
    if (!group || !value || shouldReduceMotion()) return
    const node = group.querySelector<HTMLElement>(`[data-option-id="${CSS.escape(value)}"]`)
    const badge = node?.querySelector<HTMLElement>('[data-option-badge]')
    if (badge) {
      gsap.fromTo(badge, { scale: 0.55 }, { scale: 1, duration: 0.5, ease: 'back.out(3)' })
    }
    if (node) {
      gsap.fromTo(node, { scale: 0.99 }, { scale: 1, duration: 0.35, ease: 'power2.out', clearProps: 'transform' })
    }
  }, [value])

  const focusIndex = (index: number) => {
    const group = groupRef.current
    if (!group) return
    const nodes = group.querySelectorAll<HTMLElement>('[role="radio"]')
    const next = nodes[(index + nodes.length) % nodes.length]
    next?.focus()
    const id = next?.dataset.optionId
    if (id) onChange(id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      focusIndex(index + 1)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      focusIndex(index - 1)
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      onChange(options[index].id)
    }
  }

  const selectedIndex = options.findIndex((option) => option.id === value)

  return (
    <div ref={groupRef} role="radiogroup" aria-label={label} aria-disabled={disabled} className="flex flex-col gap-1.5">
      {options.map((option, index) => {
        const selected = option.id === value
        const view = renderOption(option, { index, selected })
        return (
          <div
            key={option.id}
            role="radio"
            aria-checked={selected}
            aria-disabled={disabled}
            data-option-id={option.id}
            tabIndex={disabled ? -1 : selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            onClick={() => !disabled && onChange(option.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'group/opt relative flex items-start gap-2.5 rounded-sm px-2.5 py-2 text-left transition-[background-color,box-shadow] duration-200',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus-ring)]',
              view.separated && 'mt-1',
              selected
                ? 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--color-accent-strong)]'
                : 'bg-bg-subtle/50 shadow-[inset_0_0_0_1px_var(--color-border-faint)]',
              disabled
                ? 'cursor-not-allowed'
                : !selected && 'cursor-pointer hover:bg-surface-hover hover:shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
            )}
          >
            <span
              data-option-badge
              className={cn(
                'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro font-semibold tabular-nums transition-colors',
                selected ? 'bg-accent text-accent-ink' : 'bg-surface text-text-tertiary ring-1 ring-inset ring-border'
              )}
            >
              {selected ? <Check size={11} strokeWidth={3} /> : (view.leading ?? index + 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 text-caption font-medium text-text [overflow-wrap:anywhere]">
                  {view.title}
                </span>
                {view.badges}
              </span>
              {view.description && (
                <span className="mt-0.5 block text-micro leading-relaxed text-text-tertiary [overflow-wrap:anywhere]">
                  {view.description}
                </span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 小号徽标（产出张数 / 最推荐 / 规则命中）。 */
export function DecisionBadge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px text-micro font-medium tabular-nums',
        tone === 'accent' ? 'bg-accent/30 text-accent-ink' : 'bg-bg-subtle text-text-secondary',
        className
      )}
    >
      {children}
    </span>
  )
}
