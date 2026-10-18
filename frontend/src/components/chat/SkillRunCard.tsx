import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { SkillOption, SkillRunAttachment } from '@/lib/api/chat'

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

/**
 * 决策卡：把「产出几张、有多确定、凭什么」摊成一行，并把候选方案交给用户选。
 *
 * 只保留用户需要做判断的信息（结论 / 依据 / 方案），不展示提示词、
 * 步骤轨迹、编排规则等中间处理信息。
 */
export function SkillRunCard({ run, onConfirm }: SkillRunCardProps) {
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
    <div className="rounded-md bg-surface px-3 py-2.5 shadow-sheet">
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

      {/* 2. 历史里继续选方案：选完置 done，并保留在历史里 */}
      {selectable && (
        <div className="mt-2 flex flex-col gap-1.5">
          {options.map((option) => {
            const isChosen = chosenId === option.id
            return (
              <div
                key={option.id}
                className={cn(
                  'rounded-md px-2.5 py-2 shadow-sheet ring-1 ring-inset',
                  isChosen ? 'ring-brand bg-surface' : 'ring-border-faint bg-surface'
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
        <div className="mt-2 rounded-md bg-surface px-2.5 py-2 shadow-sheet ring-1 ring-brand">
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
