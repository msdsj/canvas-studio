import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Copy, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DURATION } from '@/lib/motion'
import type { ComposeStep } from '@/lib/api/chat'
import { StreamStep, StepTitle, SkeletonRow, type StepStatus } from './StepStream'
import { SkillChain } from './SkillChain'
import { Typewriter, TickingNumber } from './streaming'
import './streaming.css'

interface ThinkingTraceProps {
  steps: ComposeStep[]
  /** 仍在思考：头部脉冲 + 自动展开 */
  active?: boolean
  /** 最终提示词（生成出来后单独成块，方便复制/复用） */
  finalPrompt?: string
  /** 提示词来源：relay=中转站，template=本地模板（必须如实标注） */
  promptSource?: string
  className?: string
  /** 历史消息默认折叠，实时思考默认展开 */
  defaultExpanded?: boolean
}

/** 后端没有发步骤时的链路预知：与 compose_service.STEPS 的五个阶段一致。 */
const STAGE_PREVIEW = ['读懂需求', '歧义检查', '推导方案', '生成提示词', '提交生图'] as const

/** 正在「想」的阶段还拿不到 detail 时，给两行扫描骨架，别让节点显得空。 */
function ThinkingSkeleton() {
  return (
    <div className="mt-1 flex flex-col gap-1" aria-hidden>
      <span className="relative block h-[3px] w-4/5 overflow-hidden rounded-full bg-border-faint">
        <span className="cs-shimmer absolute inset-0 opacity-80" />
      </span>
      <span className="relative block h-[3px] w-1/2 overflow-hidden rounded-full bg-border-faint">
        <span className="cs-shimmer absolute inset-0 opacity-80" />
      </span>
    </div>
  )
}

/** 单个步骤的正文：detail 打字机 + items 依次递进。 */
function StepBody({
  step,
  live,
}: {
  step: ComposeStep
  live: boolean
}) {
  const items = step.items ?? []
  // detail 与 items 是同一次 SSE 里到的；detail 打完之前不要抢跑
  const detailLen = step.detail ? Math.min(step.detail.length * 0.016, 0.6) : 0
  return (
    <>
      {step.detail && (
        <p className="mt-0.5 text-micro leading-relaxed text-text-tertiary [overflow-wrap:anywhere]">
          <Typewriter text={step.detail} live={live && items.length === 0} />
        </p>
      )}
      {items.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5">
          {items.map((item, index) => (
            <li
              key={`${step.id}-item-${index}`}
              className="flex gap-1.5 text-micro leading-relaxed text-text-tertiary [overflow-wrap:anywhere]"
            >
              <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-text-faint" aria-hidden />
              <span className="min-w-0">
                <Typewriter text={item} delay={detailLen + 0.03 + index * 0.06} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** 收敛态摘要行的数字（耗时滚动，不每帧 setState）。 */
function TotalSeconds({ ms }: { ms: number }) {
  return <TickingNumber value={Math.round(ms) / 1000} duration={DURATION.slow} suffix="s" />
}

/**
 * 全链路思考：读懂需求 → 歧义检查 → 推导方案 → 生成提示词 → 提交生图。
 *
 * 为什么不用一个转圈：用户要判断的是「它有没有真的理解我」，
 * 所以每一步都必须给**具体内容**（它读出了什么、为什么停下、提示词长什么样）。
 *
 * 流式时序（这是本组件的核心）：
 *  1. 提交瞬间先铺五条**占位薄条**，用户一眼看到链路总长；
 *  2. 某一步到 running：该节点点亮、连接线从上一步长下来、标题下方出现扫描骨架；
 *  3. 该步 done：detail / items 打字机递进，耗时数字滚动，占位条被真实内容替换；
 *  4. 全部结束：自动收成一行「AI 用 X.Xs 完成 N 步编排 · 命中 M 个技能」，可再展开。
 * 历史消息（defaultExpanded=false）默认收起，不播打字机——它们不是「刚刚发生」的。
 */
export function ThinkingTrace({
  steps,
  active = false,
  finalPrompt,
  promptSource,
  className,
  defaultExpanded,
}: ThinkingTraceProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? active)
  const [copied, setCopied] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)

  // 开始思考时自动展开；结束时不强制收起（用户可能正在看）
  useEffect(() => {
    if (active) setExpanded(true)
  }, [active])

  const totalMs = useMemo(
    () => steps.reduce((sum, step) => sum + (step.elapsed_ms || 0), 0),
    [steps]
  )
  const doneCount = steps.filter((step) => step.status === 'done' || step.status === 'blocked').length
  const isTemplate = promptSource === 'template'
  const runningStep = steps.find((step) => step.status === 'running')
  const allSettled =
    steps.length > 0 &&
    steps.every((step) => step.status !== 'running' && step.status !== 'pending')
  // 全部结束后收成一行摘要；仍在跑时保持展开
  const collapsed = !expanded

  const skillNames = useMemo(() => {
    const names: string[] = []
    for (const step of steps) {
      for (const item of step.items ?? []) {
        const match = /^(?:套用技能|技能)[：:]\s*(.+)$/.exec(item.trim())
        if (match && !match[1].startsWith('通用')) names.push(match[1].trim())
      }
    }
    return [...new Set(names)]
  }, [steps])

  const heading = active ? 'AI 正在思考…' : allSettled ? 'AI 完成全链路思考' : 'AI 全链路思考'

  const copyPrompt = async () => {
    if (!finalPrompt) return
    try {
      await navigator.clipboard.writeText(finalPrompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* 剪贴板被拒不影响使用 */
    }
  }

  return (
    <div
      className={cn('overflow-hidden rounded-[14px] border border-border bg-surface', className)}
      role="status"
      aria-live="polite"
      aria-busy={active}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
        aria-expanded={expanded}
      >
        {active ? (
          <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
            <span className="absolute h-4 w-4 animate-ping rounded-full bg-accent opacity-40" />
            <Sparkles size={13} className="relative text-text" />
          </span>
        ) : (
          <Sparkles size={13} className={cn('shrink-0', allSettled ? 'text-success' : 'text-text-tertiary')} />
        )}
        <span className={cn('text-caption font-medium', active ? 'text-text' : 'text-text-secondary')}>
          {heading}
        </span>
        {isTemplate && (
          <span className="shrink-0 rounded-full bg-warning-subtle px-1.5 py-0.5 text-micro text-warning">
            本地模板
          </span>
        )}
        <span className="ml-auto shrink-0 text-micro tabular-nums text-text-tertiary">
          {doneCount}/{steps.length || STAGE_PREVIEW.length}
          {totalMs > 0 && (
            <>
              {' · '}
              <TotalSeconds ms={totalMs} />
            </>
          )}
        </span>
        <ChevronDown
          size={14}
          className={cn('shrink-0 text-text-tertiary transition-transform', expanded && 'rotate-180')}
        />
      </button>

      {/* 收敛态摘要：收起时也要让用户知道「刚才发生了什么」 */}
      {collapsed && allSettled && (
        <div className="px-3 pb-2.5">
          <p className="text-micro leading-relaxed text-text-tertiary">
            <TotalSeconds ms={totalMs} /> 内完成 {steps.length} 步编排
            {skillNames.length > 0 && ` · 命中 ${skillNames.length} 个技能（${skillNames.slice(0, 2).join('、')}${skillNames.length > 2 ? '…' : ''}）`}
            {finalPrompt && ' · 提示词已生成'}
          </p>
        </div>
      )}

      {expanded && (
        <div className="border-t border-border/60 px-3 pb-2.5 pt-2">
          <ol className="relative flex flex-col gap-2.5">
            {steps.length === 0
              ? STAGE_PREVIEW.map((title, index) => (
                  <SkeletonRow key={`preview-${title}`} title={title} />
                ))
              : steps.map((step, index) => {
                  const status = step.status as StepStatus
                  const isGhost = status === 'pending'
                  const isLive = status === 'running' && active
                  const isEmpty = !step.detail && !(step.items?.length)
                  return (
                    <StreamStep
                      key={`${step.id}-${index}`}
                      status={status}
                      connector={index < steps.length - 1}
                      connectorLit={!isGhost}
                      ghost={isGhost}
                    >
                      <StepTitle
                        title={step.title}
                        status={status}
                        ghost={isGhost}
                        elapsed={
                          step.elapsed_ms > 0 ? (
                            <span className="shrink-0 text-micro tabular-nums text-text-faint">
                              <TickingNumber value={step.elapsed_ms} suffix="ms" />
                            </span>
                          ) : status === 'running' ? (
                            <span className="shrink-0 text-micro text-accent-ink/70">进行中</span>
                          ) : null
                        }
                      />
                      {isLive && isEmpty ? (
                        <ThinkingSkeleton />
                      ) : (
                        <StepBody step={step} live={isLive} />
                      )}
                    </StreamStep>
                  )
                })}
            {/* 还有阶段没到、但列表已经出现：尾部用预知条补齐剩余长度 */}
            {steps.length > 0 &&
              steps.length < STAGE_PREVIEW.length &&
              active &&
              STAGE_PREVIEW.slice(steps.length).map((title) => (
                <SkeletonRow key={`tail-${title}`} title={title} />
              ))}
          </ol>

          <SkillChain steps={steps} active={active} className="mt-2.5" />

          {finalPrompt && (
            <div className="mt-2.5 rounded-[10px] bg-bg-subtle px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <span className="text-micro font-medium text-text-secondary">最终提示词</span>
                <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] text-text-tertiary">
                  {isTemplate ? '本地模板' : '中转站生成'}
                </span>
                <button
                  type="button"
                  onClick={() => void copyPrompt()}
                  className="ml-auto inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-text"
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
              <p
                className={cn(
                  'mt-1 text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]',
                  !promptOpen && 'line-clamp-3'
                )}
              >
                {finalPrompt}
              </p>
              {finalPrompt.length > 90 && (
                <button
                  type="button"
                  onClick={() => setPromptOpen((prev) => !prev)}
                  className="mt-1 text-[10px] text-brand-text hover:underline"
                >
                  {promptOpen ? '收起' : '展开全文'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
