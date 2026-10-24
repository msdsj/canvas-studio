import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
  /** 次要行动：与主行动并列但弱一级 */
  secondaryAction?: { label: string; onClick: () => void }
  /** 提示列表：说明"这里能做什么"，最多三条 */
  hints?: string[]
  className?: string
  children?: ReactNode
}

/**
 * 空状态（v3）。
 *
 * 改造前所有空状态都是"一个灰圆 + 一行标题"，用户看了也不知道下一步该干什么。
 * 现在固定四段结构：**图形 → 标题 → 说明 → 行动**，并可选一段提示列表。
 *
 * 图形用 72×72 的圆角方框（不是大灰圆）：圆角方框与卡片的 16px 圆角同族，
 * 读起来是"一张纸卡里的图形"，而不是"一个空洞"。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  hints,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex min-h-[var(--empty-min-h)] flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {Icon && (
        <span className="cs-glyph-in mb-1 flex h-[var(--empty-glyph)] w-[var(--empty-glyph)] items-center justify-center rounded-[16px] bg-bg-subtle text-text-tertiary ring-1 ring-border-faint">
          <Icon size={28} strokeWidth={1.5} />
        </span>
      )}
      <h3 className="text-h3 font-semibold tracking-[-0.01em] text-text">{title}</h3>
      {description && (
        <p className="max-w-[46ch] text-ui leading-relaxed text-text-secondary">{description}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action && (
            <Button size="sm" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button size="sm" variant="secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
      {hints && hints.length > 0 && (
        <ul className="mt-3 max-w-[360px] space-y-1 text-left">
          {hints.slice(0, 3).map((hint) => (
            <li key={hint} className="flex items-start gap-2 text-caption text-text-tertiary">
              <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent-strong" />
              <span>{hint}</span>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  )
}
