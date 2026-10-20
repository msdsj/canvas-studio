import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SkillOption, SkillRunAttachment } from '@/lib/api/chat'
import { DecisionBadge, DecisionCard, DecisionOptions, type DecisionTone } from './agent/DecisionCard'

interface SkillRunCardProps {
  /** assistant 消息 attachments 里的 skill_run 附件 */
  run: SkillRunAttachment
  /**
   * 历史里继续选择方案（走同一个 confirmRun 流程）。
   * 不传则不渲染可选方案，只展示结论。
   */
  onConfirm?: (runId: string, optionId: string, fingerprint: string) => Promise<void>
}

const KNOWN_RULES = ['explicit_count', 'structure', 'ambiguous', 'needs_image', 'model_plan']

/**
 * 选区分析的决策卡：把「产出几张、有多确定、凭什么」摊成一行，并把候选方案交给用户选。
 *
 * 展示结论、依据和独立输出任务；处理步骤由消息上方的 AgentTrace 承担。
 *
 * 交互约束与确认卡一致：点方案只是选中，点主按钮才执行。
 */
export function SkillRunCard({ run, onConfirm }: SkillRunCardProps) {
  const { t } = useTranslation('agent')
  // 刷新后要能看出「上次选的是哪个方案」：优先用服务端回写的 chosen_option_id
  const [chosenId, setChosenId] = useState<string | null>(run.chosen_option_id ?? null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(run.status === 'completed')
  const [voided, setVoided] = useState(false)

  const fingerprint = run.selection_fingerprint ?? ''
  const ruleLabel = useMemo(() => {
    const hit = run.rule_hit ?? ''
    return KNOWN_RULES.includes(hit) ? t(`decision.rule.${hit}`) : ''
  }, [run.rule_hit, t])

  const options: SkillOption[] = Array.isArray(run.options) ? run.options : []
  const jobs = Array.isArray(run.jobs) ? run.jobs : []
  // 只有「当时停下来等确认」且还没执行过、且有方案的记录才允许继续选
  const selectable =
    Boolean(onConfirm) && !done && !voided && run.status === 'confirm' && options.length > 0

  const confirm = async () => {
    const optionId = selected
    if (!onConfirm || !optionId || busy || done) return
    setBusy(true)
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
      setBusy(false)
    }
  }

  const chosen = chosenOption(options, chosenId)
  const tone: DecisionTone = voided ? 'voided' : done ? 'done' : busy ? 'choosing' : selectable ? 'pending' : 'done'

  const summary = (
    <span className="flex flex-wrap items-center gap-1.5">
      <DecisionBadge>{t('decision.summary', { count: run.image_count })}</DecisionBadge>
      <DecisionBadge>{t('decision.confidence', { value: Math.round(run.confidence) })}</DecisionBadge>
      {ruleLabel && <DecisionBadge tone="accent">{ruleLabel}</DecisionBadge>}
    </span>
  )

  return (
    <DecisionCard
      tone={tone}
      status={
        voided
          ? t('decision.voided')
          : done
            ? t('decision.started')
            : selectable
              ? t('decision.paused')
              : t('decision.ended')
      }
      reason={
        <>
          {summary}
          {run.reason && <p className="mt-1.5">{run.reason}</p>}
        </>
      }
      runId={run.run_id}
      busy={busy}
      footer={
        selectable ? (
          <>
            <Button
              size="sm"
              variant="primary"
              className="h-8 shrink-0 px-3 text-caption"
              disabled={busy || !selected}
              onClick={() => void confirm()}
            >
              {busy ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" /> {t('decision.submitting')}
                </span>
              ) : (
                t('decision.confirm')
              )}
            </Button>
            <span className="min-w-0 flex-1 text-micro text-text-tertiary">
              {selected ? t('decision.click_to_start') : t('decision.pick_first')}
            </span>
          </>
        ) : done ? (
          /*
            done 态要把「选的是哪一个」摆出来，而不是只把按钮变灰：
            刷新后用户回来核对时，光看到禁用按钮是判断不出方案的。
          */
          <span className="min-w-0 flex-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
            {chosenId ? t('decision.chosen_label', { label: chosen?.label ?? chosenId }) : null}
            {chosen && <> · {t('decision.count', { count: chosen.image_count })}</>}
            {chosenId ? ' · ' : ''}
            {t('decision.generating_below')}
          </span>
        ) : voided ? (
          <span className="text-micro text-text-tertiary">{t('decision.selection_changed')}</span>
        ) : null
      }
    >
      {jobs.length > 0 && (
        <div>
          <p className="text-micro font-medium text-text-secondary">{t('decision.task_breakdown', { count: jobs.length })}</p>
          <ol className="mt-2 flex flex-col gap-1.5">
            {jobs.map((job, index) => (
              <li key={`${job.index}:${index}`} className="rounded-sm bg-bg-subtle/60 px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-ink">{job.index || index + 1}</span>
                  <p className="min-w-0 flex-1 text-micro font-medium text-text [overflow-wrap:anywhere]">{job.label}</p>
                  {job.output_kind && <span className="shrink-0 text-[10px] text-text-tertiary">{t(`decision.output_kind.${job.output_kind}`, { defaultValue: job.output_kind })}</span>}
                </div>
                {Array.isArray(job.region_indexes) && job.region_indexes.length > 0 && <p className="mt-1 text-micro text-text-tertiary">{t('result.regions', { indexes: job.region_indexes.join(', ') })}</p>}
                {job.preserve_outside && <p className="mt-0.5 text-micro text-text-tertiary">{t('decision.preserve_outside')}</p>}
                {job.prompt && <details className="mt-1 text-micro text-text-tertiary">
                  <summary className="cursor-pointer hover:text-text">{t('decision.job_instruction')}</summary>
                  <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed text-text-secondary [overflow-wrap:anywhere]">{job.prompt}</p>
                </details>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {selectable && (
        <DecisionOptions
          options={options}
          value={selected}
          onChange={setSelected}
          disabled={busy}
          label={t('decision.options_label')}
          renderOption={(option) => ({
            title: option.label,
            description: option.description,
            badges: <DecisionBadge>{t('decision.count', { count: option.image_count })}</DecisionBadge>,
          })}
        />
      )}
    </DecisionCard>
  )
}

/** 取方案对象（用于显示产出张数）；找不到返回 null。 */
function chosenOption(options: SkillOption[], optionId: string | null): SkillOption | null {
  if (!optionId) return null
  return options.find((option) => option.id === optionId) ?? null
}
