import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Loader2, PencilLine, Quote, Sparkles } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { VERBATIM_OPTION_ID, type ComposeOption } from '@/lib/api/chat'
import { DecisionBadge, DecisionCard, DecisionOptions } from './agent/DecisionCard'

export type ClarifyState = 'pending' | 'choosing' | 'done' | 'voided'

interface ClarifyCardProps {
  runId: string
  /** 为什么要问（模型的判定依据，证明不是随口一问） */
  reply: string
  options: ComposeOption[]
  state: ClarifyState
  chosenId?: string
  onChoose: (optionId: string) => Promise<void>
  /**
   * 「都不是，我想…」：用户自己写方向。发出去等于一句新需求（会让本卡作废），
   * 所以由父层决定怎么提交；不传则不显示这个入口。
   */
  onCustom?: (text: string) => void
  className?: string
}

/**
 * 歧义澄清卡：需求不明确时**停在这里**，由用户选一个方向或自己补充描述。
 *
 * 每个选项代表一个**画面方向**——选中即代表「就按这个方向画」，服务端直接拿去生图。
 * 选项背后的提示词属中间处理信息，不在这里展示。
 *
 * 交互约束：点方案只是选中，点主按钮才执行；绝不自动执行。
 * 第一个选项由服务端排序为最推荐，这里只负责标出「最推荐」，不改顺序。
 */
export function ClarifyCard({
  runId,
  reply,
  options,
  state,
  chosenId,
  onChoose,
  onCustom,
  className,
}: ClarifyCardProps) {
  const { t } = useTranslation('agent')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customText, setCustomText] = useState('')
  const customRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 自定义方向输入行：展开时补间真实高度，展开后自动聚焦
  useLayoutEffect(() => {
    const el = customRef.current
    if (!el || !customOpen) return
    inputRef.current?.focus()
    if (shouldReduceMotion()) return
    const tween = gsap.fromTo(
      el,
      { height: 0, opacity: 0 },
      { height: 'auto', opacity: 1, duration: 0.36, ease: 'power3.out', clearProps: 'height' }
    )
    return () => {
      tween.kill()
    }
  }, [customOpen])

  const submitCustom = () => {
    const text = customText.trim()
    if (!text || !onCustom) return
    onCustom(text)
    setCustomText('')
    setCustomOpen(false)
  }

  const settled = state === 'done'
  const voided = state === 'voided'
  const locked = settled || voided
  const active = locked ? (chosenId ?? selected) : (selected ?? chosenId ?? null)

  useEffect(() => {
    if (locked) setBusy(false)
  }, [locked])

  const confirm = async () => {
    if (locked || busy || !active) return
    setBusy(true)
    try {
      await onChoose(active)
    } catch {
      setBusy(false)
    }
  }

  const status = settled
    ? t('decision.started')
    : voided
      ? t('decision.voided')
      : t('decision.paused')

  const hint = locked ? t('decision.ended') : busy ? t('decision.starting') : t('decision.paused_hint')

  return (
    <DecisionCard
      tone={busy ? 'choosing' : state}
      status={status}
      title={reply}
      reason={hint}
      runId={runId}
      busy={busy}
      className={className}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            className="h-8 shrink-0 px-3 text-caption"
            disabled={locked || busy || !active}
            onClick={() => void confirm()}
          >
            {busy ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> {t('decision.starting')}
              </span>
            ) : settled ? (
              t('decision.chosen')
            ) : (
              t('decision.confirm_direction')
            )}
          </Button>
          {!locked && !busy && onCustom && !customOpen && (
            <button
              type="button"
              onClick={() => setCustomOpen(true)}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-caption text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <PencilLine size={12} /> {t('decision.custom_open')}
            </button>
          )}
          <span className="min-w-0 flex-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
            {voided
              ? t('decision.voided_hint')
              : settled
                ? t('decision.generating_below')
                : active
                  ? t('decision.click_to_start')
                  : t('decision.pick_first')}
          </span>
        </>
      }
    >
      <DecisionOptions
        options={options}
        value={active}
        onChange={setSelected}
        disabled={locked || busy}
        label={t('decision.options_label')}
        renderOption={(option, { index }) => {
          // 最后一条固定是「直接用我的原话」：它不是一个"方案"，而是用户的退出权
          const isVerbatim = option.id === VERBATIM_OPTION_ID
          return {
            title: option.label,
            description: option.description,
            separated: isVerbatim,
            leading: isVerbatim ? <Quote size={10} /> : undefined,
            badges:
              index === 0 && !isVerbatim ? (
                <DecisionBadge tone="accent">
                  <Sparkles size={9} /> {t('decision.recommended')}
                </DecisionBadge>
              ) : isVerbatim ? (
                <DecisionBadge>{t('decision.verbatim')}</DecisionBadge>
              ) : option.image_count > 1 ? (
                <DecisionBadge>{t('decision.count', { count: option.image_count })}</DecisionBadge>
              ) : null,
          }
        }}
      />
      {customOpen && !locked && (
        <div ref={customRef} className="overflow-hidden">
          <form
            className="mt-2 flex items-center gap-1.5 rounded-sm bg-bg-subtle/70 py-1 pl-2.5 pr-1 ring-1 ring-inset ring-border-faint focus-within:ring-accent-strong"
            onSubmit={(event) => {
              event.preventDefault()
              submitCustom()
            }}
          >
            <input
              ref={inputRef}
              value={customText}
              onChange={(event) => setCustomText(event.target.value.slice(0, 500))}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCustomOpen(false)
              }}
              placeholder={t('decision.custom_placeholder')}
              aria-label={t('decision.custom_placeholder')}
              className="min-w-0 flex-1 bg-transparent text-caption text-text placeholder:text-text-faint focus:outline-none"
            />
            <button
              type="submit"
              disabled={!customText.trim()}
              aria-label={t('decision.custom_send')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity disabled:opacity-40"
            >
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          </form>
          <p className="mt-1 pl-1 text-micro text-text-faint">{t('decision.custom_hint')}</p>
        </div>
      )}
    </DecisionCard>
  )
}
