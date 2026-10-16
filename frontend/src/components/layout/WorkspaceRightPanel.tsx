import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface WorkspaceRightPanelProps {
  children: ReactNode
  className?: string
  open?: boolean
}

/** 工作台右栏容器（AI 对话面板）。 */
export function WorkspaceRightPanel({ children, className, open = true }: WorkspaceRightPanelProps) {
  if (!open) return null
  return (
    <aside
      className={cn(
        'flex w-[380px] shrink-0 flex-col border-l border-border bg-surface',
        className
      )}
    >
      {children}
    </aside>
  )
}
