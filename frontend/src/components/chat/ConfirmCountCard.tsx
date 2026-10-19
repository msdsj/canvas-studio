import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SkillOption } from '@/lib/api/chat'
import { DecisionBadge, DecisionCard, DecisionOptions } from './agent/DecisionCard'

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
 * 1. **绝不倒计时自动执行**——未经用户点主按钮，一分额度都不花出去；
 * 2. **点卡片只是选中，点主按钮才执行**——避免误触直接产生费用。
 *
 * 外壳与方案控件和澄清卡共用（DecisionCard），保证所有「让用户选」的动作长得一样。
 */
export function ConfirmCountCard({
  reply,
  reason,
  options,
  runId,
  state,
  chosenId,
  onChoose,
}: ConfirmCountCardProps) {
  const { t } = useTranslation('agent')
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
    <DecisionCard
      tone={busy ? 'choosing' : state}
      status={settled ? t('decision.started') : voided ? t('decision.voided') : t('decision.paused')}
      title={reply}
      reason={reason || undefined}
      runId={runId}
      busy={busy || state === 'choosing'}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            className="h-8 shrink-0 px-3 text-caption"
            disabled={locked || busy || !activeChosen}
            onClick={() => void confirm()}
          >
            {busy ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> {t('decision.submitting')}
              </span>
            ) : settled ? (
              t('decision.chosen')
            ) : (
              t('decision.confirm')
            )}
          </Button>
          <span className="min-w-0 flex-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
            {voided
              ? t('decision.voided_hint')
              : settled
                ? t('decision.chosen_label', { label: optionLabel(options, activeChosen) })
                : t('decision.confirm_to_start')}
          </span>
        </>
      }
    >
      <DecisionOptions
        options={options}
        value={activeChosen}
        onChange={setLocalChosen}
        disabled={locked || busy}
        label={t('decision.options_label')}
        renderOption={(option) => ({
          title: option.label,
          description: option.description,
          badges: <DecisionBadge>{t('decision.count', { count: option.image_count })}</DecisionBadge>,
        })}
      />
    </DecisionCard>
  )
}

/** 取方案标题；找不到时退回 id，避免出现「已选择：undefined」。 */
function optionLabel(options: SkillOption[], optionId: string | null): string {
  if (!optionId) return '—'
  return options.find((option) => option.id === optionId)?.label ?? optionId
}
