import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Brain, Check, ChevronDown, CircleDashed, Cpu, Loader2, MinusCircle } from 'lucide-react'
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
  /** 模型面向用户公开返回的分析摘要（可展开回看） */
  thought?: string
  /** 模型 / 耗时 / 输出量 */
  meta?: { model?: string; elapsed_ms?: number; output_chars?: number; streamed?: boolean }
}

/**
 * 面向用户的结构化执行计划。
 *
 * 这里刻意只接收「公开计划」：产出数量、选区编号、任务标签和执行约束。
 * 模型的内部推理不会被当作计划渲染；若有完整执行指令，放在可选的
 * details 里由用户主动展开，避免左侧对话一上来被长文本撑满。
 */
export interface TracePlan {
  imageCount?: number
  confidence?: number
  summary?: string
  subject?: string
  intent?: string
  style?: string
  constraints?: string[]
  observations?: string[]
  count_reason?: string
  reason?: string
  countReason?: string
  ruleHit?: string
  jobs?: Array<{
    index?: number
    label?: string
    prompt?: string
    handler?: string
    region_indexes?: number[]
    output_kind?: string
    preserve_outside?: boolean
  }>
  outputs?: Array<{
    label?: string
    count?: number
    handler?: string
    description?: string
    kind?: string
    region_indexes?: number[]
    preserve_outside?: boolean
  }>
}

interface AgentTraceProps {
  steps: TraceStep[]
  /** 已完成分析后返回的结构化产出计划（可选）。 */
  plan?: TracePlan | null
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
  /** 实时模式：模型正在写出的分析摘要 */
  thought?: string
  /** 实时模式：进入结构化输出后已写出的字数 */
  thoughtChars?: number
  /** 历史模式默认展开（刚完成的那一轮保持展开，过程与回答同屏） */
  defaultOpen?: boolean
  className?: string
}

/** 需求分析的等待节奏（秒）：通常 8–15s；25s 起提示偏慢，90s 交给用户决定 */
const ANALYSIS_TIMING = { expectedSeconds: 12, softSeconds: 25, hardSeconds: 90 }

/**
 * Agent 公开处理轨迹。
 *
 * 展示实际返回的步骤、分析摘要、需求约束和决策依据。
 * 每个任务实际使用的指令由任务卡展示。
 *
 * 动效分工：
 * - 新到达的步骤与要点由 GSAP 逐条升起（按 id 记账，已出现过的不重播）；
 * - 历史模式的展开/收起用 GSAP 补间真实高度，避免 max-height 魔法数；
 * - 运行中的连接线流光、头像光环是 CSS 持续动画（见 agent.css / streaming.css）。
 */
export function AgentTrace({
  steps,
  plan,
  live = false,
  skillId,
  skillName,
  onStop,
  onRetry,
  offline = false,
  thought = '',
  thoughtChars = 0,
  defaultOpen = false,
  className,
}: AgentTraceProps) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(live || defaultOpen)
  const bodyRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const firstPaintRef = useRef(true)

  // 实时模式自己计时：SSE 的 elapsed_ms 只在步骤结束时才有，等待期间需要一个会动的数字
  const timer = useStageTimer({ active: live, ...ANALYSIS_TIMING })
  const liveSeconds = timer.elapsed

  useEffect(() => {
    if (live || defaultOpen) setOpen(true)
  }, [live, defaultOpen])

  const totalMs = steps.reduce((sum, step) => sum + (Number(step.elapsed_ms) || 0), 0)
  const seconds = live ? liveSeconds : Math.round(totalMs / 1000)
  const failed = steps.some((step) => step.status === 'failed')
  const blocked = steps.some((step) => step.status === 'blocked')
  const stopped = !live && !failed && steps.some((step) => step.status === 'skipped' && step.detail === t('trace.stopped'))
  const completed = steps.filter((step) => step.status === 'done').length
  const currentStep = steps.find((step) => step.status === 'running')
  const model = [...steps].reverse().find((step) => step.meta?.model)?.meta?.model
  const planOutputs = plan?.imageCount || plan?.jobs?.length || plan?.outputs?.reduce((sum, item) => sum + (Number(item.count) || 0), 0)

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

  const title = live ? t('trace.live_title') : failed ? t('trace.failed_title') : blocked ? t('trace.blocked_title') : stopped ? t('trace.stopped_title') : t('trace.done_title')

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
      {steps.length > 0 && (
        <span className="text-micro tabular-nums text-text-tertiary">
          {live ? t('trace.completed_steps', { completed, total: steps.length }) : t('trace.steps', { count: steps.length })}
          {!live && totalMs > 0 && <> · {t('trace.elapsed', { seconds: seconds || (totalMs / 1000).toFixed(1) })}</>}
        </span>
      )}
      {planOutputs ? (
        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-ink">
          {t('trace.plan_outputs', { count: planOutputs })}
        </span>
      ) : null}
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
              currentStep?.title ?? t('trace.waiting')
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

      {plan && <PlanSummary plan={plan} />}

      <div ref={bodyRef} className={cn(!live && 'overflow-hidden')}>
        {(thought || thoughtChars > 0) && (live || !steps.some((step) => step.thought === thought)) && (
          <ThoughtStream text={thought} chars={thoughtChars} active={live} model={model} />
        )}
        {showPlaceholder ? (
          <div className="mt-2 flex items-center gap-2 rounded-sm bg-bg-subtle/60 px-2.5 py-2 text-micro text-text-tertiary" aria-busy>
            <Loader2 size={13} className="shrink-0 animate-spin text-accent-ink" />
            <span>{t('trace.connecting')}</span>
          </div>
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

/**
 * 把「为什么是这些产出」放在分析轨迹里，而不是只在结果卡出现。
 * 这样用户能在生成前就核对张数、区域和每项职责，发现理解偏差时可以立刻停止。
 */
function PlanSummary({ plan }: { plan: TracePlan }) {
  const { t } = useTranslation('agent')
  const jobs = Array.isArray(plan.jobs) ? plan.jobs.filter(Boolean) : []
  const outputs = Array.isArray(plan.outputs) ? plan.outputs.filter(Boolean) : []
  const count = Number(plan.imageCount) || jobs.length || outputs.reduce((sum, item) => sum + (Number(item.count) || 0), 0)
  const confidence = typeof plan.confidence === 'number'
    ? Math.round(plan.confidence <= 1 ? plan.confidence * 100 : plan.confidence)
    : null
  const groups: Array<{
    index?: number
    label?: string
    prompt?: string
    description?: string
    output_kind?: string
    kind?: string
    region_indexes?: number[]
    preserve_outside?: boolean
  }> = jobs.length > 0 ? jobs : outputs
  const facts = [
    plan.subject ? t('trace.plan_subject', { value: plan.subject }) : '',
    plan.intent ? t('trace.plan_intent', { value: plan.intent }) : '',
    plan.style ? t('trace.plan_style', { value: plan.style }) : '',
  ].filter(Boolean)
  const notes = [...(plan.observations ?? []), ...(plan.constraints ?? [])].filter(Boolean)
  if (!count && groups.length === 0 && !plan.reason && !plan.summary && facts.length === 0 && notes.length === 0) return null

  return (
    <div className="mt-2 overflow-hidden rounded-sm bg-accent-soft/40 ring-1 ring-inset ring-accent/20">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-accent/15 px-2.5 py-2">
        <span className="flex items-center gap-1.5 text-micro font-semibold text-accent-ink">
          <Brain size={12} /> {t('trace.plan_title')}
        </span>
        {count > 0 && <span className="rounded-full bg-surface/70 px-1.5 py-0.5 text-[11px] font-medium text-text-secondary">{t('trace.plan_outputs', { count })}</span>}
        {groups.length > 0 && groups.length !== count && <span className="rounded-full bg-surface/70 px-1.5 py-0.5 text-[11px] text-text-tertiary">{t('trace.plan_tasks', { count: groups.length })}</span>}
        {confidence !== null && <span className="ml-auto text-[11px] tabular-nums text-text-tertiary">{t('trace.plan_confidence', { value: confidence })}</span>}
      </div>
      {plan.summary && <p className="px-2.5 pt-2 text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{plan.summary}</p>}
      {facts.length > 0 && <div className="flex flex-wrap gap-1 px-2.5 pt-2">{facts.map((fact) => <span key={fact} className="rounded-full bg-surface/70 px-2 py-0.5 text-[11px] text-text-tertiary">{fact}</span>)}</div>}
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 px-2.5 pt-2 text-[11px] leading-relaxed text-text-tertiary">
          {notes.slice(0, 6).map((note, index) => <li key={`${index}:${note}`} className="flex gap-1.5"><span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-accent-strong" /><span className="min-w-0 [overflow-wrap:anywhere]">{note}</span></li>)}
        </ul>
      )}
      {plan.reason && <p className="px-2.5 pt-2 text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{plan.reason}</p>}
      {(plan.countReason || plan.count_reason) && <p className="px-2.5 pt-1 text-[11px] text-text-tertiary">{t('trace.plan_count_basis', { value: plan.countReason || plan.count_reason })}</p>}
      {plan.ruleHit && <p className="px-2.5 pt-1 text-[11px] text-text-tertiary">{t('trace.plan_basis', { value: plan.ruleHit })}</p>}
      {groups.length > 0 && (
        <ol className="flex flex-col gap-1.5 px-2.5 py-2">
          {groups.slice(0, 12).map((job, index) => {
            const item = job
            const itemIndex = Number(item.index) || index + 1
            const regions = Array.isArray(item.region_indexes) ? item.region_indexes.filter(Number.isInteger) : []
            const kind = item.output_kind || item.kind
            const detail = item.description || item.prompt
            return (
              <li key={`${itemIndex}:${item.label || index}`} className="flex min-w-0 items-start gap-2 rounded-xs bg-surface/60 px-2 py-1.5">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-ink">{itemIndex}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="min-w-0 flex-1 text-micro font-medium text-text [overflow-wrap:anywhere]">{item.label || t('trace.plan_item', { index: itemIndex })}</span>
                    {kind && <span className="shrink-0 text-[11px] text-text-tertiary">{t(`decision.output_kind.${kind}`, { defaultValue: kind })}</span>}
                  </div>
                  {regions.length > 0 && <p className="mt-0.5 text-[11px] text-text-tertiary">{t('trace.plan_regions', { indexes: regions.join(', ') })}</p>}
                  {item.preserve_outside && <p className="mt-0.5 text-[11px] text-text-tertiary">{t('trace.plan_preserve')}</p>}
                  {detail && (
                    <details className="mt-0.5 text-[11px] text-text-tertiary">
                      <summary className="cursor-pointer hover:text-text">{t('trace.plan_details')}</summary>
                      <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{detail}</p>
                    </details>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {groups.length > 12 && <p className="px-2.5 pb-2 text-[11px] text-text-tertiary">{t('trace.plan_more', { count: groups.length - 12 })}</p>}
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
          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5 text-[11px]', running ? 'bg-accent-soft text-accent-ink' : step.status === 'failed' ? 'bg-danger-subtle text-danger' : 'bg-bg-subtle text-text-tertiary')}>{statusLabel}</span>
          {seconds && step.status !== 'running' && (
            <span className="shrink-0 text-micro tabular-nums text-text-faint">{seconds}s</span>
          )}
        </div>
        {step.detail && (
          <p className="mt-0.5 text-micro leading-relaxed text-text-tertiary [overflow-wrap:anywhere]">
            {step.detail}
          </p>
        )}
        {step.meta && <StepMeta meta={step.meta} />}
        {step.thought && <StepThought text={step.thought} />}
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

/**
 * 展示模型公开返回的分析摘要与真实接收的输出量。
 * 进入结构化输出阶段后保留摘要，仅更新已接收的字符数。
 */
function ThoughtStream({ text, chars, active, model }: { text: string; chars: number; active: boolean; model?: string }) {
  const { t } = useTranslation('agent')
  const boxRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [text])
  const total = text.length + chars
  return (
    <div className="mt-2 overflow-hidden rounded-xs ring-1 ring-inset ring-border-faint" aria-live="polite">
      <div className="flex items-center gap-1.5 bg-bg-subtle/70 px-2.5 py-1.5 text-micro text-text-tertiary">
        <Brain size={12} className="text-accent-ink" />
        <span className="font-medium text-text-secondary">{t('trace.thought_live')}</span>
        <span className="ml-auto tabular-nums">
          {model && <span className="mr-1.5">{model}</span>}
          {t('trace.output_chars', { chars: total })}
        </span>
      </div>
      {text && (
        <div
          ref={boxRef}
          className="max-h-[240px] overflow-y-auto whitespace-pre-wrap px-2.5 py-2 text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]"
        >
          {text}
          {active && chars === 0 && (
            <span className="cs-caret ml-0.5 inline-block h-[1em] w-[2px] rounded-full bg-accent-strong align-[-0.15em]" />
          )}
        </div>
      )}
      {active && chars > 0 && (
        <div className="flex items-center gap-1.5 border-t border-border-faint px-2.5 py-1.5 text-micro text-text-tertiary">
          <Loader2 size={11} className="animate-spin text-accent-ink" />
          <span className="tabular-nums">{t('trace.structuring', { chars })}</span>
        </div>
      )}
    </div>
  )
}

/** 一步的可量化信息：模型 · 耗时 · 输出字数。 */
function StepMeta({ meta }: { meta: NonNullable<TraceStep['meta']> }) {
  const { t } = useTranslation('agent')
  const seconds = meta.elapsed_ms ? (meta.elapsed_ms / 1000).toFixed(1) : null
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-micro tabular-nums text-text-faint">
      <Cpu size={11} className="shrink-0" />
      <span className="font-medium text-text-tertiary">{meta.model}</span>
      {seconds && <span>· {seconds}s</span>}
      {meta.output_chars ? <span>· {t('trace.output_chars', { chars: meta.output_chars })}</span> : null}
      {meta.streamed && <span>· {t('trace.streamed')}</span>}
    </p>
  )
}

/** 面向用户的分析摘要：默认完整展示，支持收起。 */
function StepThought({ text }: { text: string }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(true)
  return (
    <div className="mt-1.5 rounded-xs bg-bg-subtle/60 px-2.5 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-micro font-medium text-text-tertiary hover:text-text"
      >
        <Brain size={11} className="shrink-0 text-accent-ink" />
        <span className="flex-1">{open ? t('trace.hide_thought') : t('trace.show_thought')}</span>
        <ChevronDown size={12} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      <p
        className={cn(
          'mt-1 whitespace-pre-wrap text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]',
          !open && 'line-clamp-1'
        )}
      >
        {text}
      </p>
    </div>
  )
}
