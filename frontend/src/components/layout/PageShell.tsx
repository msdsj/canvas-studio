import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageShellProps {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  /** 内容最大宽度：default=1280（唯一常用档） / wide=1440（宽表逃生档） / narrow=880（单列表单） */
  width?: 'default' | 'wide' | 'narrow'
  className?: string
  /** 页头下方的 tabs 行（渲染在页头内部、描述下方） */
  tabs?: ReactNode
  /** 页头是否吸顶（≥1024px 生效；吸附过程尺寸零变化） */
  sticky?: boolean
  /** 底部安全间距：有浮动操作条的页面用 'float' */
  bottomPad?: 'default' | 'float'
}

/**
 * 登录后普通页面的统一框架（PageShell v3）。
 *
 * v3 解决的核心问题：**20 个页面各写一套壳**。
 * 改造前标题左沿散落在 56 / 104 / 140 / 188 / 203 / 238 / 296px 七处，
 * 原因是同时存在 5 种 max-width 与 3 套 gutter。现在只有一套刻度：
 *
 *   gutter  20px(<640) / 32px(≥640) / 48px(≥1024)
 *   宽度    1280px（默认）/ 1440px（宽表）/ 880px（单列）
 *
 * 1440 视口下所有页面的内容左沿恒为 **128px**。
 *
 * 结构上有一条硬要求：**吸顶层是滚动容器的直接子元素且横跨整宽**，
 * 1280px 的内容容器放在它内部。否则滚动时页头两侧会露出纸底，
 * 看起来像"内容从页面底下钻出来"。
 */
const WIDTH: Record<string, string> = {
  narrow: 'max-w-[var(--shell-max-narrow)]',
  default: 'max-w-[var(--shell-max)]',
  wide: 'max-w-[var(--shell-max-wide)]',
}

const GUTTER =
  'px-[var(--shell-gutter)] md:px-[var(--shell-gutter-md)] lg:px-[var(--shell-gutter-lg)]'

export function PageShell({
  title,
  description,
  actions,
  children,
  width = 'default',
  className,
  tabs,
  sticky = true,
  bottomPad = 'default',
}: PageShellProps) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLSpanElement>(null)
  const headRef = useRef<HTMLDivElement>(null)

  // 吸附判定：哨兵元素（1px，绝对定位在内容顶部）滚出视口即视为"已吸附"。
  // 用 IntersectionObserver 而不是 scroll 事件——后者在长列表上会每帧回调。
  useEffect(() => {
    const scroller = scrollerRef.current
    const sentinel = sentinelRef.current
    const head = headRef.current
    if (!scroller || !sentinel || !head) return
    if (!('IntersectionObserver' in window)) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          head.dataset.stuck = entry.isIntersecting ? 'false' : 'true'
        }
      },
      { root: scroller, rootMargin: '-1px 0px 0px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={scrollerRef}
      className="relative h-full min-h-0 overflow-y-auto overscroll-contain"
      style={{ scrollbarGutter: 'stable' }}
    >
      {/* 哨兵：贴在内容最上方，滚出去 = 页头已经吸住 */}
      <span ref={sentinelRef} aria-hidden className="pointer-events-none absolute left-0 top-0 h-px w-full" />

      <div
        ref={headRef}
        data-stuck="false"
        className={cn(
          'cs-sticky-edge relative overflow-hidden bg-bg',
          sticky && 'sticky top-0 z-20',
        )}
      >
        {/* 页头弥散光：蓝 → 青 → 薄荷的一层薄雾，只在顶部亮，向下化开。
            页头吸顶后这层光仍在纸底上，不会出现一条硬边。 */}
        <div aria-hidden className="cs-diffuse-wash pointer-events-none absolute inset-0" />
        <div className={cn('relative mx-auto w-full', WIDTH[width], GUTTER)}>
          <header className="cs-enter flex flex-col gap-4 pt-5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <h1 className="text-h2 font-semibold tracking-[-0.016em] text-text">{title}</h1>
              {description && (
                <p className="mt-2 max-w-[64ch] text-ui leading-relaxed text-text-secondary">
                  {description}
                </p>
              )}
            </div>
            {actions && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                {actions}
              </div>
            )}
          </header>
          {tabs && <div className="mt-4">{tabs}</div>}
        </div>
      </div>

      <div
        className={cn(
          'cs-enter-item mx-auto w-full',
          WIDTH[width],
          GUTTER,
          bottomPad === 'float'
            ? 'pb-[var(--shell-bottom-pad-float)]'
            : 'pb-[var(--shell-bottom-pad)]',
          className,
        )}
        style={{ '--i': 1 } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * 页头 tabs：墨黑指示条（青柠每屏只留给 ≤2 处信号）。
 *
 * 指示条用 `after:` 伪元素压在 tabs 行的下沿，选中时由墨黑渐显，
 * 过渡只走 color / transform，不动布局。
 */
export function PageTabs({
  items,
  value,
  onChange,
  className,
}: {
  items: { key: string; label: string; count?: number }[]
  value: string
  onChange: (key: string) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn('flex items-center gap-6 border-b border-border-faint', className)}
    >
      {items.map((item) => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={cn(
              'relative h-10 text-ui font-medium transition-colors duration-[160ms]',
              'text-text-tertiary hover:text-text',
              'after:absolute after:inset-x-0 after:-bottom-px after:h-[2px]',
              'after:bg-transparent after:transition-colors after:duration-[160ms]',
              active && 'text-text font-semibold after:bg-brand',
            )}
          >
            {item.label}
            {typeof item.count === 'number' && (
              <span className="ml-1.5 text-micro tabular-nums text-text-tertiary">
                {item.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
