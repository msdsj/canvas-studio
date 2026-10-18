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
          'w-full rounded-[10px] border bg-surface px-3 py-2.5 text-ui leading-relaxed text-text placeholder:text-text-tertiary',
          'transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10',
          'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-tertiary',
          invalid ? 'border-danger' : 'border-border-strong',
          className
        )}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'
