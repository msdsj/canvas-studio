import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './button'
import { cn } from '@/lib/utils'

interface PaginationProps {
  page: number
  size: number
  total: number
  onPageChange: (page: number) => void
  onSizeChange?: (size: number) => void
  className?: string
}

/** 分页控件。 */
export function Pagination({ page, size, total, onPageChange, onSizeChange, className }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / size))
  return (
    <div className={cn('flex items-center justify-between gap-3 py-3', className)}>
      <span className="text-sm text-text-secondary">
        共 {total} 条 · 第 {page} / {totalPages} 页
      </span>
      <div className="flex items-center gap-2">
        {onSizeChange && (
          <select
            className="h-8 rounded-lg border border-border-strong bg-surface px-2 text-sm text-text"
            value={size}
            onChange={(e) => onSizeChange(Number(e.target.value))}
          >
            {[10, 20, 50, 100].map((value) => (
              <option key={value} value={value}>
                {value} / 页
              </option>
            ))}
          </select>
        )}
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="上一页"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </Button>
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="下一页"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  )
}
