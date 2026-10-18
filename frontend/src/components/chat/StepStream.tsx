import { useEffect, useRef } from 'react'
import { Check, Minus, ShieldAlert, X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion, EASE } from '@/lib/motion'
import { cn } from '@/lib/utils'

/**
 * 流式步骤（节点 + 生长中的连接线 + 状态灯）。
 *
 * 视觉契约（ThinkingTrace / AnalysisSteps 共用，保证两处观感一致）：
 * - 节点圆点在左侧一个固定宽度的槽里，连接线画在槽中央的 1px 竖线上；
 * - 连接线只在**节点首次出现**时用 `scaleY` 从上方长下来，之后不再重播
 *   （每次 SSE 都抽一下，会让人以为页面在抖）；
 * - 运行中（running）是青柠呼吸光晕 + 一条顺着链路往下流的扫描光：
 *   青柠是唯一信号色，只在这里出现；
 * - 颜色全部走语义 token（text-* / bg-* / border-*），暗色主题自动跟随。
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed'

const STATUS_TEXT: Record<StepStatus, string> = {
  pending: 'text-text-tertiary',
  running: 'text-text',
  done: 'text-text',
  skipped: 'text-text-tertiary',
  blocked: 'text-warning',
  failed: 'text-danger',
}

/** 运行中的节点：外圈呼吸光晕 + 中间实心青柠点。 */
function RunningNode() {
  return (
    <span className="relative flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
      <span className="absolute inset-[-4px] animate-pulse rounded-full bg-accent/25" />
      <span className="absolute h-2.5 w-2.5 rounded-full bg-accent/40" />
      <span className="relative h-1.5 w-1.5 rounded-full bg-accent-strong" />
    </span>
  )
}

export function StatusNode({ status }: { status: StepStatus }) {
  if (status === 'running') return <RunningNode />
  if (status === 'done') {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface" aria-hidden>
        <Check size={11} className="text-success" strokeWidth={3} />
      </span>
    )
  }
  if (status === 'blocked') return <ShieldAlert size={11} className="shrink-0 text-warning" strokeWidth={2.4} aria-hidden />
  if (status === 'failed') return <X size={11} className="shrink-0 text-danger" strokeWidth={3} aria-hidden />
  if (status === 'skipped') return <Minus size={11} className="shrink-0 text-text-faint" strokeWidth={3} aria-hidden />
  return <span className="h-1.5 w-1.5 rounded-full border border-border-strong bg-surface" aria-hidden />
}

/** 骨架占位条：提交瞬间就能看到链路长度，并预知每一步「大概多长」。 */
export function SkeletonRow({ title }: { title: string }) {
  return (
    <li className="relative flex items-center gap-2.5 py-[4px]" aria-hidden>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="h-[5px] w-[5px] rounded-full bg-border-strong/60" />
      </span>
      <span className="shrink-0 text-caption leading-snug text-text-tertiary/80">{title}</span>
      <span className="relative ml-0.5 h-px flex-1 overflow-hidden rounded-full bg-border">
        <span className="cs-shimmer absolute inset-x-0 -inset-y-[1px] opacity-90" />
      </span>
    </li>
  )
}

interface StreamStepProps {
  status: StepStatus
  connector?: boolean
  /** 连接线以上是否已经点亮（决定线是深一档还是淡） */
  connectorLit?: boolean
  /** 骨架先行阶段：整行淡化，还没轮到它 */
  ghost?: boolean
  children?: React.ReactNode
  className?: string
}

/**
 * 一行流式步骤。连接线绝对定位在节点槽中央，右侧内容多高都能准确连到下一个节点。
 */
export function StreamStep({
  status,
  connector = true,
  connectorLit = true,
  ghost = false,
  children,
  className,
}: StreamStepProps) {
  const lineRef = useRef<HTMLSpanElement | null>(null)
  const lineDone = useRef(false)
  const live = status === 'running'

  // 连接线：首次出现时从 0 长到满（scaleY），之后再重渲染不重播
  useEffect(() => {
    const el = lineRef.current
    if (!el || lineDone.current) return
    lineDone.current = true
    if (shouldReduceMotion()) return
    const tween = gsap.fromTo(
      el,
      { scaleY: 0 },
      { scaleY: 1, duration: 0.34, ease: EASE.inOut, clearProps: 'transform' }
    )
    return () => {
      tween.kill()
    }
  }, [])

  return (
    <li className={cn('relative flex items-start gap-2.5', className)}>
      {connector && (
        <span
          aria-hidden
          className={cn(
            'absolute left-[6px] bottom-[-9px] top-[14px] w-px origin-top overflow-hidden',
            connectorLit ? 'bg-border-strong/60' : 'bg-border'
          )}
        >
          <span
            ref={lineRef}
            className={cn('relative block h-full w-full origin-top', live && 'cs-stream-flow')}
          />
        </span>
      )}

      <span
        className={cn(
          'relative z-[1] mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full',
          ghost ? 'bg-transparent' : 'bg-surface'
        )}
      >
        <StatusNode status={status} />
      </span>

      <div className={cn('min-w-0 flex-1', ghost && 'opacity-60')}>{children}</div>
    </li>
  )
}

/** 标题行：运行中的标题保持正文色，其余按状态给语义色。 */
export function StepTitle({
  title,
  status,
  ghost,
  elapsed,
}: {
  title: string
  status: StepStatus
  ghost?: boolean
  elapsed?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={cn('text-caption leading-snug', ghost ? 'text-text-tertiary' : STATUS_TEXT[status])}>
        {title}
      </span>
      {elapsed}
    </div>
  )
}
