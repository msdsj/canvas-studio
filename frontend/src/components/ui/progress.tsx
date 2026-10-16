import { cn } from '@/lib/utils'

interface ProgressProps {
  value: number
  className?: string
  tone?: 'brand' | 'warning' | 'danger'
}

/** 进度条。 */
export function Progress({ value, className, tone = 'brand' }: ProgressProps) {
  const clamped = Math.max(0, Math.min(100, value))
  const toneClass =
    tone === 'warning' ? 'bg-warning' : tone === 'danger' ? 'bg-danger' : 'bg-brand'
  return (
    <div
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle', className)}
    >
      <div className={cn('h-full rounded-full transition-all duration-300', toneClass)} style={{ width: `${clamped}%` }} />
    </div>
  )
}
