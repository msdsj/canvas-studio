import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  /**
   * 媒体变体：卡片本身不内距（`p-0`），图片放在自己的托盘里。
   *
   * 修的是「竖图被裁掉大半」：普通卡片里用 `object-cover` 会把 351×1238
   * 的竖图切成正方形，只剩中间一条。媒体变体改用「卡纸 + 完整图」
   * （`object-contain`），露出的底色是卡纸而不是裁掉的部分。
   */
  media?: boolean
}

/**
 * 卡片容器。
 *
 * `interactive` 时：悬停抬升 2px + 阴影加深 + 边框变实，按压回弹。
 * 只用 transform / box-shadow / border-color —— 全部走合成层，
 * 网格里几十张卡片同时 hover 也不会掉帧。
 * 缩略图缩放由外层 `.cs-zoom` 单独负责，避免位移与缩放互相打架。
 */
export function Card({ className, interactive, media, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[16px] border border-border/70 bg-surface p-5 shadow-sheet',
        media && 'p-0',
        interactive &&
          'cursor-pointer transition-[transform,box-shadow,border-color] duration-[240ms] ease-[var(--ease-out)] hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift active:translate-y-0 active:scale-[0.995]',
        className
      )}
      {...props}
    />
  )
}

/** 图片托盘：媒体卡的图床，露出的底色是卡纸而不是裁掉的部分。 */
export function CardMedia({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden bg-[var(--card-media-mat)]',
        className,
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
