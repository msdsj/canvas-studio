import * as React from 'react'
import { cn } from '@/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
}

/** 文本输入框。 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'h-9 w-full rounded-lg border bg-surface px-3 text-base text-text placeholder:text-text-tertiary',
          'transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)]',
          'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-tertiary',
          invalid ? 'border-danger' : 'border-border-strong hover:border-border-strong focus:border-brand',
          className
        )}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'
