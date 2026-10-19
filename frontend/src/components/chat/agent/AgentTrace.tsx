import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, ChevronDown, CircleDashed, Loader2, MinusCircle } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { useStageTimer } from '@/hooks/use-stage-timer'
import { SkillChip } from './SkillChip'
import { WaitStatus } from './WaitStatus'
import '../streaming.css'
import './agent.css'

/** ComposeStep 与 SkillStepState 的公共子集：两条链路的轨迹用同一个组件画。 */
export interface TraceStep {
  id: string
  title: string
  detail: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed'
  elapsed_ms: number
  items?: string[]
}

interface AgentTraceProps {
  steps: TraceStep[]
  /** 实时模式：始终展开 + 计时；历史模式：折叠成一行摘要，可展开 */
  live?: boolean
  skillId?: string | null
  skillName?: string | null
  /** 实时模式：停止这次分析（与输入框的停止键同一个动作） */
  onStop?: () => void
  /** 实时模式：硬超时后重新提交同一句话 */
  onRetry?: () => void
  /** 网络断开：等待条改为「已断网，恢复后自动续上」 */
  offline?: boolean
  className?: string
}

/** 需求分析的等待节奏（秒）：通常 8–15s；25s 起提示偏慢，90s 交给用户决定 */
const ANALYSIS_TIMING = { expectedSeconds: 12, softSeconds: 25, hardSeconds: 90 }

const PLACEHOLDER_KEYS = ['understand', 'skill', 'plan', 'prepare'] as const

/**
 * Agent 思考轨迹。
 *
 * 只展示「每一步在做什么、得出了哪些要点」——步骤标题 / 一句说明 / 推理要点；
 * 最终提示词属中间产物，不在这里出现（产品规则）。
 *
 * 动效分工：
 * - 新到达的步骤与要点由 GSAP 逐条升起（按 id 记账，已出现过的不重播）；
 * - 历史模式的展开/收起用 GSAP 补间真实高度，避免 max-height 魔法数；
 * - 运行中的连接线流光、头像光环是 CSS 持续动画（见 agent.css / streaming.css）。
 */
export function AgentTrace({
  steps,
  live = false,
  skillId,
  skillName,
  onStop,
  onRetry,
  offline = false,
  className,
}: AgentTraceProps) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(live)
  const bodyRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const firstPaintRef = useRef(true)

  // 实时模式自己计时：SSE 的 elapsed_ms 只在步骤结束时才有，等待期间需要一个会动的数字
  const timer = useStageTimer({ active: live, ...ANALYSIS_TIMING })
  const liveSeconds = timer.elapsed

  useEffect(() => {
    if (live) setOpen(true)
  }, [live])

  const totalMs = steps.reduce((sum, step) => sum + (Number(step.elapsed_ms) || 0), 0)
  const seconds = live ? liveSeconds : Math.max(1, Math.round(totalMs / 1000))
  const failed = steps.some((step) => step.status === 'failed')

  // 实时模式：新步骤 / 新要点逐条升起（按 key 记账，已出现过的不重播）
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !live) return
    const fresh: HTMLElement[] = []
    list.querySelectorAll<HTMLElement>('[data-trace-key]').forEach((node) => {
      const key = node.dataset.traceKey as string
      if (seenRef.current.has(key)) return
      seenRef.current.add(key)
      fresh.push(node)
    })
    if (fresh.length === 0 || shouldReduceMotion()) return
    gsap.fromTo(
      fresh,
      { opacity: 0, y: 6, filter: 'blur(2px)' },
      {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        duration: 0.42,
        stagger: 0.055,
        ease: 'power3.out',
        clearProps: 'filter,transform',
      }
    )
  }, [steps, live])

  // 历史模式展开/收起：补间真实高度；展开时步骤轻 stagger 落位
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || live) return
    const instant = firstPaintRef.current || shouldReduceMotion()
    firstPaintRef.current = false
    if (instant) {
      gsap.set(body, { height: open ? 'auto' : 0, opacity: open ? 1 : 0 })
      return
    }
    const tl = gsap.timeline()
    tl.to(body, {
      height: open ? 'auto' : 0,
      opacity: open ? 1 : 0,
      duration: open ? 0.46 : 0.32,
      ease: open ? 'power3.out' : 'power2.inOut',
      overwrite: 'auto',
    })
    if (open && listRef.current) {
      const rows = listRef.current.querySelectorAll<HTMLElement>(':scope > li')
      tl.fromTo(
        rows,
        { opacity: 0, x: -6 },
        { opacity: 1, x: 0, duration: 0.36, stagger: 0.05, ease: 'power2.out', clearProps: 'transform' },
        0.08
      )
    }
    return () => {
      tl.kill()
    }
  }, [open, live])

  const showPlaceholder = live && steps.length === 0

  const title = live ? t('trace.live_title') : failed ? t('trace.failed_title') : t('trace.done_title')

  const header = (
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span
        className={cn(
          'text-caption font-medium',
          live ? 'cs-agent-shine' : failed ? 'text-danger' : 'text-text-secondary'
        )}
      >
        {title}
      </span>
      {/* 实时模式的计时在下方等待条里，这里不重复 */}
      {!live && (
        <span className="text-micro tabular-nums text-text-tertiary">
          {steps.length > 0 && <>{t('trace.steps', { count: steps.length })} · </>}
          {t('trace.elapsed', { seconds })}
        </span>
      )}
    </span>
  )

  return (
    <div className={cn('min-w-0', className)}>
      {live ? (
        <>
          <div className="flex items-center gap-1.5">{header}</div>
          <WaitStatus
            className="mt-2"
            kind="analysis"
            timer={timer}
            offline={offline}
            label={
              steps.find((step) => step.status === 'running')?.title ??
              t(`trace.placeholder.${PLACEHOLDER_KEYS[Math.min(3, Math.floor(liveSeconds / 4))]}`)
            }
            onStop={onStop}
            onRetry={onRetry}
          />
        </>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={open ? t('trace.collapse') : t('trace.expand')}
          className="group/trace -mx-1.5 flex w-[calc(100%+12px)] items-center gap-1.5 rounded-xs px-1.5 py-1 text-left transition-colors hover:bg-surface-hover"
        >
          <span
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
              failed ? 'bg-danger-subtle text-danger' : 'bg-accent-soft text-accent-ink'
            )}
          >
            {failed ? <AlertCircle size={10} /> : <Check size={10} strokeWidth={3} />}
          </span>
          {header}
          <ChevronDown
            size={14}
            className={cn(
              'shrink-0 text-text-tertiary transition-transform duration-300 group-hover/trace:text-text',
              open && 'rotate-180'
            )}
          />
        </button>
      )}

      {(skillId || skillName) && (
        <div className="mt-1.5">
          <SkillChip skillId={skillId} name={skillName} />
        </div>
      )}

      <div ref={bodyRef} className={cn(!live && 'overflow-hidden')}>
        {showPlaceholder ? (
          <ol className="mt-2 flex flex-col gap-2.5 pl-0.5" aria-busy>
            {PLACEHOLDER_KEYS.map((key, index) => (
              <li key={key} className="flex items-center gap-2.5">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {index === 0 ? (
                    <Loader2 size={13} className="animate-spin text-accent-ink" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
                  )}
                </span>
                <span
                  className={cn(
                    'text-caption',
                    index === 0 ? 'text-text-secondary' : 'text-text-faint'
                  )}
                >
                  {t(`trace.placeholder.${key}`)}
                </span>
                {index === 0 && <span className="cs-agent-bar h-1 w-12 shrink-0" />}
              </li>
            ))}
          </ol>
        ) : (
          <ol ref={listRef} className="relative mt-2 flex flex-col pl-0.5">
            {steps.map((step, index) => (
              <TraceRow
                key={step.id}
                step={step}
                last={index === steps.length - 1}
                statusLabel={t(`trace.status.${step.status}`, { defaultValue: '' })}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: TraceStep['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 size={13} className="animate-spin text-accent-ink" />
    case 'done':
      return (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink">
          <Check size={10} strokeWidth={3} />
        </span>
      )
    case 'failed':
      return <AlertCircle size={14} className="text-danger" />
    case 'blocked':
      return (
        <span className="relative flex h-3 w-3 items-center justify-center">
          <span className="absolute h-3 w-3 animate-ping rounded-full bg-warning/50" />
          <span className="relative h-2 w-2 rounded-full bg-warning" />
        </span>
      )
    case 'skipped':
      return <MinusCircle size={13} className="text-text-faint" />
    default:
      return <CircleDashed size={13} className="text-text-faint" />
  }
}

function TraceRow({
  step,
  last,
  statusLabel,
}: {
  step: TraceStep
  last: boolean
  statusLabel: string
}) {
  const running = step.status === 'running'
  const items = Array.isArray(step.items) ? step.items.filter(Boolean) : []
  const seconds = step.elapsed_ms > 0 ? (step.elapsed_ms / 1000).toFixed(1) : null

  return (
    <li data-trace-key={step.id} className="relative flex gap-2.5 pb-3 last:pb-0">
      {/* 竖向连接线：运行中的那一段有青柠流光往下走 */}
      {!last && (
        <span
          aria-hidden
          className={cn(
            'absolute bottom-0 left-[7.5px] top-[20px] w-px',
            running ? 'cs-stream-flow bg-border' : 'bg-border'
          )}
        />
      )}
      <span className="relative mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center bg-surface">
        <StatusIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 text-caption font-medium [overflow-wrap:anywhere]',
              step.status === 'skipped' ? 'text-text-tertiary line-through decoration-text-faint' : 'text-text'
            )}
          >
            {step.title}
          </p>
          <span className="sr-only">{statusLabel}</span>
          {seconds && step.status === 'done' && (
            <span className="shrink-0 text-micro tabular-nums text-text-faint">{seconds}s</span>
          )}
        </div>
        {step.detail && (
          <p className="mt-0.5 text-micro leading-relaxed text-text-tertiary [overflow-wrap:anywhere]">
            {step.detail}
          </p>
        )}
        {items.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-1 rounded-xs bg-bg-subtle/60 px-2.5 py-2">
            {items.map((item, index) => (
              <li
                key={`${step.id}:${index}`}
                data-trace-key={`${step.id}:${index}`}
                className="flex gap-1.5 text-micro leading-relaxed text-text-secondary"
              >
                <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent-strong" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{item}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}
