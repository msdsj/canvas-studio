import { cn } from '@/lib/utils'

interface SpinnerProps {
  size?: number
  className?: string
}

/** 环形加载指示器。 */
export function Spinner({ size = 18, className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={cn('inline-block animate-spin rounded-full border-2 border-brand border-t-transparent', className)}
      style={{ width: size, height: size }}
    />
  )
}
