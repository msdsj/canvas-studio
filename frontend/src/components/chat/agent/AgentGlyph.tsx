import { Sparkle } from 'lucide-react'
import { cn } from '@/lib/utils'
import './agent.css'

interface AgentGlyphProps {
  size?: number
  /** 工作中：外圈锥形光旋转 + 核心呼吸 */
  active?: boolean
  className?: string
}

/** Agent 的头像：所有 AI 回复、分析轨迹、结果卡共用，替代泛化的字母头像。 */
export function AgentGlyph({ size = 24, active = false, className }: AgentGlyphProps) {
  return (
    <span
      aria-hidden
      data-active={active}
      className={cn('cs-agent-glyph shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <Sparkle size={Math.round(size * 0.5)} strokeWidth={2.4} fill="currentColor" />
    </span>
  )
}
