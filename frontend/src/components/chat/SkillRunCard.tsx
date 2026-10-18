import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Minus, ShieldAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { SkillOption, SkillRunAttachment, SkillStepState } from '@/lib/api/chat'

interface SkillRunCardProps {
  /** assistant 消息 attachments 里的 skill_run 附件 */
  run: SkillRunAttachment
  /**
   * 历史里继续选择方案（走同一个 confirmRun 流程）。
   * 不传则不渲染可选卡片，只展示轨迹。
   */
  onConfirm?: (runId: string, optionId: string, fingerprint: string) => Promise<void>
}

/** 命中规则 → 给用户看的一句人话（证明判定依据，而不是黑箱）。 */
const RULE_LABEL: Record<string, string> = {
  explicit_count: '按你指定的数量',
  structure: '按选区结构判定',
  ambiguous: '表述不唯一',
  needs_image: '缺少底图',
}

/** 步骤状态图标：running 脉冲点 / done 勾 / skipped 灰线 / blocked 警示 / failed 叉。 */
function StepIcon({ status }: { status: SkillStepState['status'] }) {
  if (status === 'running') {
    return (
      <span className="relative flex h-2 w-2 items-center justify-center">
        <span className="absolute h-2 w-2 animate-ping rounded-full bg-brand opacity-60" />
        <span className="relative h-1.5 w-1.5 rounded-full bg-brand" />
      </span>
    )
  }
  if (status === 'done') return <Check size={12} className="text-success" strokeWidth={2.5} />
  if (status === 'skipped') return <Minus size={12} className="text-text-faint" strokeWidth={2.5} />
  if (status === 'blocked')
    return <ShieldAlert size={12} className="text-warning" strokeWidth={2.2} />
  if (status === 'failed') return <X size={12} className="text-danger" strokeWidth={2.5} />
  return <span className="h-1.5 w-1.5 rounded-full border border-border-strong" />
}

const STEP_TEXT: Record<SkillStepState['status'] | 'default', string> = {
  pending: 'text-text-tertiary',
  running: 'text-text',
  done: 'text-text-secondary',
  skipped: 'text-text-tertiary',
  blocked: 'text-warning',
  failed: 'text-danger',
  default: 'text-text-secondary',
}

/**
 * 历史消息里的「编排轨迹」卡：证明 AI 是照着预设规则走的。
 *
 * 三层信息，从上到下逐级展开（默认折叠最底层，避免侧栏里堆成一片）：
 * 1. 决策摘要一行：产出 N 张 · 置信度 X% · 命中规则标签；
 * 2. 步骤轨迹：每一步的标题 / 细节 / 耗时；
 * 3. 「编排规则」折叠区：把 Skill 的 rules 摊开，用户可自行核对。
 */
export function SkillRunCard({ run, onConfirm }: SkillRunCardProps) {
  const [rulesOpen, setRulesOpen] = useState(false)
  // 刷新后要能看出「上次选的是哪个方案」：优先用服务端回写的 chosen_option_id
  const [chosenId, setChosenId] = useState<string | null>(run.chosen_option_id ?? null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [done, setDone] = useState(run.status === 'completed')
  const [voided, setVoided] = useState(false)

  const fingerprint = run.selection_fingerprint ?? ''
  const ruleLabel = useMemo(() => {
    const hit = run.rule_hit ?? ''
    return RULE_LABEL[hit] ?? ''
  }, [run.rule_hit])

  const options: SkillOption[] = Array.isArray(run.options) ? run.options : []
  const steps: SkillStepState[] = Array.isArray(run.steps) ? run.steps : []
  const rules: string[] = Array.isArray(run.skill?.rules) ? run.skill.rules : []
  // 只有「当时停下来等确认」且还没执行过、且有方案的记录才允许继续选
  const selectable =
    Boolean(onConfirm) && !done && !voided && run.status === 'confirm' && options.length > 0

  const choose = async (optionId: string) => {
    if (!onConfirm || busyId || done) return
    setBusyId(optionId)
    setChosenId(optionId)
    try {
      await onConfirm(run.run_id, optionId, fingerprint)
      setDone(true)
    } catch (error) {
      // 409 = 选区变了，这次分析作废；其余错误由父层 toast，这里只恢复可点
      const code = (error as { code?: string })?.code
      if (code === 'TASK_STATE_CONFLICT') setVoided(true)
      setChosenId(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface px-3 py-2.5">
      {/* 1. 决策摘要：一行说清「产出几张、有多确定、凭什么」 */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-caption font-medium tabular-nums text-text">
          产出 {run.image_count} 张
        </span>
        <span className="text-micro text-text-tertiary">·</span>
        <span className="text-caption tabular-nums text-text-secondary">
          置信度 {Math.round(run.confidence)}%
        </span>
        {ruleLabel && (
          <span className="ml-auto shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro font-medium text-text-secondary">
            {ruleLabel}
          </span>
        )}
      </div>

      {run.reason && (
        <p className="mt-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
          {run.reason}
        </p>
      )}

      {/* 2. 步骤轨迹 */}
      {steps.length > 0 && (
        <ol className="mt-2 flex flex-col gap-1.5">
          {steps.map((step, index) => (
            <li key={`${step.id}-${index}`} className="flex items-start gap-2">
              <span className="mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center">
                <StepIcon status={step.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      'text-caption leading-snug',
                      STEP_TEXT[step.status] ?? STEP_TEXT.default
                    )}
                  >
                    {step.title}
                  </span>
                  {step.elapsed_ms > 0 && (
                    <span className="shrink-0 text-micro tabular-nums text-text-faint">
                      {step.elapsed_ms}ms
                    </span>
                  )}
                </div>
                {step.detail && (
                  <p className="mt-0.5 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* 3. 历史里继续选方案：选完置 done，并保留在历史里 */}
      {selectable && (
        <div className="mt-2 flex flex-col gap-1.5">
          {options.map((option) => {
            const isChosen = chosenId === option.id
            return (
              <div
                key={option.id}
                className={cn(
                  'rounded-[14px] border px-2.5 py-2',
                  isChosen ? 'border-brand bg-surface' : 'border-border bg-surface'
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 text-caption font-medium text-text [overflow-wrap:anywhere]">
                    {option.label}
                  </span>
                  <span className="shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro font-medium tabular-nums text-text-secondary">
                    产出 {option.image_count} 张
                  </span>
                </div>
                {option.description && (
                  <p className="mt-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                    {option.description}
                  </p>
                )}
                <Button
                  size="sm"
                  variant={isChosen ? 'primary' : 'secondary'}
                  className="mt-1.5 h-7 px-2.5 text-caption"
                  disabled={Boolean(busyId)}
                  onClick={() => void choose(option.id)}
                >
                  {busyId === option.id ? '正在提交…' : '就按这个来'}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {/*
        done 态要把「选的是哪一个」摆出来，而不是只把按钮变灰：
        刷新后用户回来核对时，光看到禁用按钮是判断不出方案的。
      */}
      {done && (
        <div className="mt-2 rounded-[14px] border border-brand bg-surface px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Check size={12} className="shrink-0 text-success" strokeWidth={2.5} />
            <span className="min-w-0 flex-1 text-caption font-medium text-text [overflow-wrap:anywhere]">
              {chosenId ? `已选择：${optionLabel(options, chosenId)}` : '已按所选方案开始生成'}
            </span>
            {chosenOption(options, chosenId) && (
              <span className="shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro font-medium tabular-nums text-text-secondary">
                产出 {chosenOption(options, chosenId)?.image_count} 张
              </span>
            )}
          </div>
          <p className="mt-1 text-micro leading-snug text-text-tertiary">正在生成，结果会出现在对话下方</p>
        </div>
      )}

      {voided && (
        <p className="mt-2 text-micro text-text-tertiary">选区在确认前变了，这次分析已作废</p>
      )}

      {/* 4. 编排规则（默认收起）：让用户能验证 AI 没有偏离预设 */}
      {rules.length > 0 && (
        <div className="mt-2 border-t border-border-faint pt-1.5">
          <button
            type="button"
            onClick={() => setRulesOpen((prev) => !prev)}
            aria-expanded={rulesOpen}
            className="flex w-full items-center gap-1 text-micro text-text-tertiary transition-colors hover:text-text-secondary"
          >
            {rulesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            编排规则
            <span className="text-text-faint">（{rules.length} 条）</span>
          </button>
          {rulesOpen && (
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-4">
              {rules.map((rule) => (
                <li
                  key={rule}
                  className="text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]"
                >
                  {rule}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** 取方案标题；找不到时退回 id，避免出现「已选择：undefined」。 */
function optionLabel(options: SkillOption[], optionId: string | null): string {
  if (!optionId) return '—'
  return options.find((option) => option.id === optionId)?.label ?? optionId
}

/** 取方案对象（用于显示产出张数）；找不到返回 null。 */
function chosenOption(options: SkillOption[], optionId: string | null): SkillOption | null {
  if (!optionId) return null
  return options.find((option) => option.id === optionId) ?? null
}
