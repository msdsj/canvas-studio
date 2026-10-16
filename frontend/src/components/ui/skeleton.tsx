import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** 骨架屏占位块。 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-lg bg-surface-hover', className)}
      {...props}
    />
  )
}
