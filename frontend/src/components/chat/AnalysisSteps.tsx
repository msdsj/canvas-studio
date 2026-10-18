import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SkillStepState } from '@/lib/api/chat'
import { StreamStep, StepTitle, SkeletonRow, StatusNode, type StepStatus } from './StepStream'
import { SkillChain } from './SkillChain'
import { Typewriter } from './streaming'
import './streaming.css'

interface AnalysisStepsProps {
  /** 服务端实时推送的步骤轨迹（按到达顺序） */
  steps: SkillStepState[]
  /** 分析仍在进行中：标题显示「正在理解需求…」并带脉冲 */
  active?: boolean
  /** 自定义标题（默认按 active 切换「正在理解需求… / 分析完成」） */
  title?: string
  className?: string
}

/** 画布选区分析在拿到首步之前，先把预知的阶段铺出来。 */
const STAGE_PREVIEW = ['识别选区', '拆解指令', '判定张数', '编排执行'] as const

/**
 * 「实时分析」块：把需求分析的每一步摊开给用户看。
 *
 * 为什么不是转圈：中转站的意义就是「可追溯」——用户要能看见系统读了什么、
 * 判定成 1 张还是 2 张、为什么直接执行或停下来问，而不是对着一个 loading 干等。
 *
 * 动效与 `ThinkingTrace` 共用同一套基底（StepStream / streaming），
 * 保证「侧栏编排」和「画布选区分析」两块看起来是同一个系统：
 * 骨架先行 → 连接线生长 → detail 打字机 → 耗时滚动 → 收敛成一行。
 */
export function AnalysisSteps({ steps, active = false, title, className }: AnalysisStepsProps) {
  const heading = title ?? (active ? '正在理解需求…' : '分析完成')
  const doneCount = steps.filter((step) => step.status === 'done').length
  const settled = steps.length > 0 && steps.every((step) => step.status === 'done' || step.status === 'skipped')

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-[14px] border border-border bg-surface px-3 py-2.5',
        className
      )}
      role="status"
      aria-live="polite"
      aria-busy={active}
    >
      <div className="flex items-center gap-1.5">
        {active ? (
          <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden>
            <span className="absolute inset-0 animate-pulse rounded-full bg-accent/40" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-accent-strong" />
          </span>
        ) : (
          <Check size={12} className="text-success" strokeWidth={2.6} aria-hidden />
        )}
        <span className="text-caption font-medium text-text">{heading}</span>
        <span className="ml-auto text-micro tabular-nums text-text-tertiary">
          {doneCount}/{steps.length || STAGE_PREVIEW.length}
        </span>
      </div>

      <ol className="relative flex flex-col gap-1.5">
        {steps.length === 0
          ? STAGE_PREVIEW.map((stage) => <SkeletonRow key={`preview-${stage}`} title={stage} />)
          : steps.map((step, index) => {
              const status = step.status as StepStatus
              const isGhost = status === 'pending'
              const isLive = status === 'running' && active
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
                          {step.elapsed_ms}ms
                        </span>
                      ) : null
                    }
                  />
                  {step.detail &&
                    (isLive ? (
                      <p className="mt-0.5 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                        <Typewriter text={step.detail} live />
                      </p>
                    ) : (
                      <p className="mt-0.5 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                        {step.detail}
                      </p>
                    ))}
                </StreamStep>
              )
            })}
        {/* 还在跑、步骤表里已经排了但没到的，用预知条补齐长度 */}
        {steps.length > 0 &&
          steps.length < STAGE_PREVIEW.length &&
          active &&
          STAGE_PREVIEW.slice(steps.length).map((stage) => (
            <SkeletonRow key={`tail-${stage}`} title={stage} />
          ))}
      </ol>

      {settled && <Footer doneCount={doneCount} steps={steps} />}
      <SkillChain steps={steps} active={active} />
    </div>
  )
}

/** 收敛脚注：一行摘要，不做成第二张卡。 */
function Footer({ doneCount, steps }: { doneCount: number; steps: SkillStepState[] }) {
  const totalMs = steps.reduce((sum, step) => sum + (step.elapsed_ms || 0), 0)
  return (
    <p className="flex items-center gap-1 text-micro text-text-tertiary">
      <StatusNode status="done" />
      <span>
        {doneCount} 步分析完成
        {totalMs > 0 && ` · ${(totalMs / 1000).toFixed(1)}s`}
      </span>
    </p>
  )
}
