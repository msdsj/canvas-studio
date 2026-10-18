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
          'h-10 w-full rounded-[10px] border bg-surface px-3 text-ui text-text placeholder:text-text-tertiary',
          'transition-[border-color,box-shadow] duration-150 focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10',
          'disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-tertiary',
          invalid ? 'border-danger' : 'border-border-strong hover:border-border-strong',
          className
        )}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'
