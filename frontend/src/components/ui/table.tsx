import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * 数据表格（v3）。
 *
 * 三条规格来自设计系统 v3：
 * 1. **表格必须包在卡片里**（`TableCard`）：外框 + 圆角 + 一层纸感阴影，
 *    不再让表头横条直接铺在页面底色上（那样看起来像"表没画完"）。
 * 2. 表头 44px（`--table-th-h`）、行高 56px（`--table-row-h`），数字列用等宽 + tabular-nums。
 * 3. **分页条是表格卡的兄弟节点，不是它的子节点**（`TablePager`）：
 *    放进卡里会被 `overflow-hidden` 吃掉，长表时分页还会被挤出视口——
 *    这正是改造前"翻页按钮看不见"的机制。
 */

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-base', className)} {...props} />
    </div>
  )
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-bg-subtle', className)} {...props} />
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn(className)} {...props} />
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border-faint transition-colors duration-[120ms] last:border-0 hover:bg-surface-hover',
        className,
      )}
      {...props}
    />
  )
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-11 whitespace-nowrap px-4 text-left text-caption font-medium uppercase tracking-[0.02em] text-text-tertiary',
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('h-14 px-4 text-text', className)} {...props} />
}

/** 表格卡：外框 + 圆角裁剪。表头的上圆角由 overflow-hidden 兜住。 */
export function TableCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[var(--table-radius)] border border-border/70 bg-surface shadow-sheet',
        className,
      )}
      {...props}
    />
  )
}

/** 数字列：等宽 + 表格数字，便于纵向比对。 */
export function TableNumber({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn('h-14 px-4 font-mono text-caption tabular-nums text-text', className)}
      {...props}
    />
  )
}
