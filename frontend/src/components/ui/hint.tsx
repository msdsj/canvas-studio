import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

interface HintProps {
  /** 鼠标悬停时显示的说明文字 */
  label: string
  /** 显示成什么：默认一个小问号图标；也可以包住任意控件 */
  children?: ReactNode
  className?: string
}

/**
 * 提示：给「只有图标没有文字」的后台操作一个可读的解释。
 *
 * 后台里大量操作是图标（分配额度、重置密码、封禁……），新管理员看不出区别。
 * 这里统一用 Tooltip 承载一句人话；`children` 为空时渲染 info 图标，
 * 有 children 时就地包住原控件（不改变原有点击行为）。
 */
export function Hint({ label, children, className }: HintProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {children ?? (
          <span
            tabIndex={0}
            role="img"
            aria-label={label}
            className={cn(
              'inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full text-text-faint transition-colors hover:text-text-tertiary',
              className,
            )}
          >
            <Info size={13} />
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] leading-relaxed">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
