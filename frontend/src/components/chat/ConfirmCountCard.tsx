import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SkillOption } from '@/lib/api/chat'

/** 卡片状态：待选 / 提交中 / 已选；`voided` 表示已被新的提交作废。 */
export type ConfirmCardState = 'pending' | 'choosing' | 'done' | 'voided'

interface ConfirmCountCardProps {
  /** 分析结论那句话（卡片标题） */
  reply: string
  /** 为什么需要你选（判定依据，证明不是随便猜） */
  reason: string
  options: SkillOption[]
  /** 分析时那片选区的指纹：确认时原样回传，服务端据此判断计划是否已作废 */
  fingerprint: string
  /** 这次分析的 run id（确认接口的路径参数） */
  runId: string
  state: ConfirmCardState
  /** 已选择的方案 id（done 态显示「已选择：xxx」） */
  chosenId?: string
  onChoose: (optionId: string) => Promise<void>
}

/**
 * 「要 1 张还是 2 张」的确认卡。
 *
 * 两条硬约束：
 * 1. **绝不倒计时自动执行**——未经用户点「就按这个来」，一分额度都不花出去；
 * 2. **点卡片只是选中，点主按钮才执行**——避免误触直接产生费用。
 */
export function ConfirmCountCard({
  reply,
  reason,
  options,
  fingerprint,
  runId,
  state,
  chosenId,
  onChoose,
}: ConfirmCountCardProps) {
  const [localChosen, setLocalChosen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const settled = state === 'done'
  const voided = state === 'voided'
  const locked = settled || voided
  // 已作废/已完成时以外部传入的 chosenId 为准（刷新后仍要显示「已选择」）
  const activeChosen = locked ? (chosenId ?? localChosen) : (localChosen ?? chosenId ?? null)

  // 外部状态切换到 done/voided 时别再留着一个"待提交"的选中态
  useEffect(() => {
    if (locked) setBusy(false)
  }, [locked])

  const confirm = async () => {
    if (locked || busy || !activeChosen) return
    setBusy(true)
    try {
      await onChoose(activeChosen)
    } catch {
      // 失败必须可重试：父层负责 toast，这里只把 loading 退回去
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'rounded-[14px] border border-border bg-surface px-3 py-2.5',
        voided && 'opacity-60'
      )}
      data-run-id={runId}
      aria-busy={busy || state === 'choosing'}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-medium leading-snug text-text [overflow-wrap:anywhere]">
            {reply}
          </p>
          {reason && (
            <p className="mt-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
              {reason}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((option) => {
          const isChosen = activeChosen === option.id
          return (
            <button
              key={option.id}
              type="button"
              disabled={locked || busy}
              aria-pressed={isChosen}
              onClick={() => setLocalChosen(option.id)}
              className={cn(
                'w-full rounded-[14px] border bg-surface px-2.5 py-2 text-left transition-colors',
                isChosen ? 'border-brand' : 'border-border',
                'disabled:cursor-not-allowed disabled:opacity-60',
                !locked && !busy && 'hover:border-brand hover:bg-surface-hover'
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 text-caption font-medium text-text [overflow-wrap:anywhere]">
                  {option.label}
                </span>
                <span className="shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro font-medium tabular-nums text-text-secondary">
                  产出 {option.image_count} 张
                </span>
                {settled && isChosen && (
                  <Check size={12} className="shrink-0 text-success" strokeWidth={2.5} />
                )}
              </span>
              {option.description && (
                <span className="mt-1 block text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                  {option.description}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          className="h-7 shrink-0 px-2.5 text-caption"
          disabled={locked || busy || !activeChosen}
          onClick={() => void confirm()}
        >
          {busy ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> 正在提交…
            </span>
          ) : settled ? (
            '已选择'
          ) : (
            '就按这个来'
          )}
        </Button>
        <span className="min-w-0 flex-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
          {voided
            ? '已作废'
            : settled
              ? `已选择：${optionLabel(options, activeChosen)}`
              : '确认后开始生成'}
        </span>
      </div>
    </div>
  )
}

/** 取方案标题；找不到时退回 id，避免出现「已选择：undefined」。 */
function optionLabel(options: SkillOption[], optionId: string | null): string {
  if (!optionId) return '—'
  return options.find((option) => option.id === optionId)?.label ?? optionId
}
