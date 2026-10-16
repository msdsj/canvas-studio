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
        // overflow-hidden + min-w-0：flex 子项默认 min-width:auto，内部图片的自然宽度（如 1254px）
        // 会把本栏从内部顶宽、导致右栏内容被视口裁切；显式裁切后 w-full 图片才能正常收缩
        'flex w-[380px] min-w-0 shrink-0 flex-col overflow-hidden border-l border-border bg-surface',
        className
      )}
    >
      {children}
    </aside>
  )
}
