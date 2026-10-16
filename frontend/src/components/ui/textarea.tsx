import * as React from 'react'
import { cn } from '@/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

/** 多行文本域。 */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full rounded-lg border bg-surface px-3 py-2 text-base text-text placeholder:text-text-tertiary',
          'transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-focus-ring)]',
          'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-tertiary',
          invalid ? 'border-danger' : 'border-border-strong focus:border-brand',
          className
        )}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'
