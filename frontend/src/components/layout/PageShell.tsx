import { useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useReveal } from '@/lib/motion'

interface PageShellProps {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  /** 内容最大宽度：默认 1240，表格类页面可传 'wide' */
  width?: 'default' | 'wide' | 'narrow'
  className?: string
}

const WIDTH: Record<string, string> = {
  narrow: 'max-w-[880px]',
  default: 'max-w-[1240px]',
  wide: 'max-w-[1480px]',
}

/**
 * 登录后普通页面的统一框架：可滚动容器 + 居中内容 + 页头 + 入场动效。
 *
 * 之前每个页面各自写 `p-6` + `text-xl`，导致标题字号、左右留白、最大宽度
 * 全都不一致——这是"页面之间看起来不像一套产品"的主要原因。
 * 入场动效也收在这里：任何页面只要用了 PageShell，就自动拥有与首页/工作室
 * 一致的「页头先落、内容随后」的节奏，不用每个页面各写一遍 GSAP。
 */
export function PageShell({
  title,
  description,
  actions,
  children,
  width = 'default',
  className,
}: PageShellProps) {
  const innerRef = useRef<HTMLDivElement>(null)

  useReveal(innerRef, {
    selector: '[data-page-block]',
    y: 14,
    stagger: 0.08,
    duration: 0.58,
    delay: 0.02,
  })

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div
        ref={innerRef}
        className={cn('mx-auto w-full px-6 py-7 lg:px-10 lg:py-9', WIDTH[width], className)}
      >
        <header data-page-block className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-h2 font-semibold tracking-[-0.016em] text-text">{title}</h1>
            {description && (
              <p className="mt-2 max-w-[64ch] text-ui leading-relaxed text-text-secondary">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
        <div data-page-block>{children}</div>
      </div>
    </div>
  )
}
