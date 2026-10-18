import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
}

/**
 * 卡片容器。
 *
 * `interactive` 时：悬停抬升 2px + 阴影加深 + 边框变实，按压回弹。
 * 只用 transform / box-shadow / border-color —— 全部走合成层，
 * 网格里几十张卡片同时 hover 也不会掉帧。
 * 缩略图缩放由外层 `.cs-zoom` 单独负责，避免位移与缩放互相打架。
 */
export function Card({ className, interactive, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[16px] border border-border/70 bg-surface p-5 shadow-sheet',
        interactive &&
          'cursor-pointer transition-[transform,box-shadow,border-color] duration-[240ms] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift active:translate-y-0 active:scale-[0.995]',
        className
      )}
      {...props}
    />
  )
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-md font-semibold text-text', className)} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-text-secondary', className)} {...props} />
}
