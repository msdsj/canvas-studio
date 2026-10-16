import type { ReactNode } from 'react'
import { Label } from './label'
import { cn } from '@/lib/utils'

interface FormFieldProps {
  label?: string
  htmlFor?: string
  error?: string
  helper?: string
  required?: boolean
  children: ReactNode
  className?: string
}

/** 表单字段容器：标签 + 控件 + 帮助/错误文本。 */
export function FormField({ label, htmlFor, error, helper, required, children, className }: FormFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={htmlFor}>
          {label}
          {required && <span className="ml-0.5 text-danger">*</span>}
        </Label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : helper ? (
        <p className="text-xs text-text-tertiary">{helper}</p>
      ) : null}
    </div>
  )
}
