import { useEffect, useState } from 'react'
import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ComposeOption } from '@/lib/api/chat'

export type ClarifyState = 'pending' | 'choosing' | 'done' | 'voided'

interface ClarifyCardProps {
  runId: string
  /** 为什么要问（模型的判定依据，证明不是随口一问） */
  reply: string
  options: ComposeOption[]
  state: ClarifyState
  chosenId?: string
  onChoose: (optionId: string) => Promise<void>
  className?: string
}

/**
 * 歧义澄清卡：需求不明确时**停在这里**，由用户选一个方向或自己补充描述。
 *
 * 与「要 1 张还是 2 张」的确认卡不同，这里每个选项都带着**完整提示词**——
 * 用户选中即代表「就按这个方向画」，服务端直接拿去生图，不再二次改写。
 */
export function ClarifyCard({
  runId,
  reply,
  options,
  state,
  chosenId,
  onChoose,
  className,
}: ClarifyCardProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openPrompt, setOpenPrompt] = useState<string | null>(null)

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

  return (
    <div
      className={cn(
        'rounded-[14px] border border-warning/40 bg-surface px-3 py-2.5',
        voided && 'opacity-60',
        className
      )}
      data-run-id={runId}
      aria-busy={busy}
    >
      <div className="flex items-start gap-1.5">
        <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-medium leading-snug text-text [overflow-wrap:anywhere]">
            {reply}
          </p>
          <p className="mt-0.5 text-micro text-text-tertiary">选定方向后开始生成</p>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((option) => {
          const isChosen = active === option.id
          const promptOpen = openPrompt === option.id
          return (
            <div
              key={option.id}
              className={cn(
                'rounded-[12px] border bg-surface px-2.5 py-2 transition-colors',
                isChosen ? 'border-brand' : 'border-border'
              )}
            >
              <button
                type="button"
                disabled={locked || busy}
                aria-pressed={isChosen}
                onClick={() => setSelected(option.id)}
                className="flex w-full items-start gap-2 text-left disabled:cursor-not-allowed"
              >
                <span
                  className={cn(
                    'mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                    isChosen ? 'border-brand bg-brand text-white' : 'border-border-strong'
                  )}
                >
                  {isChosen && <Check size={9} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-caption font-medium text-text [overflow-wrap:anywhere]">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>

              {option.prompt && (
                <div className="mt-1.5 pl-[22px]">
                  <button
                    type="button"
                    onClick={() => setOpenPrompt(promptOpen ? null : option.id)}
                    className="inline-flex items-center gap-1 text-[10px] text-text-tertiary hover:text-brand-text"
                  >
                    看看会用的提示词
                    <ChevronDown
                      size={10}
                      className={cn('transition-transform', promptOpen && 'rotate-180')}
                    />
                  </button>
                  {promptOpen && (
                    <p className="mt-1 rounded-[8px] bg-bg-subtle px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
                      {option.prompt}
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          className="h-7 shrink-0 px-2.5 text-caption"
          disabled={locked || busy || !active}
          onClick={() => void confirm()}
        >
          {busy ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> 正在开始…
            </span>
          ) : settled ? (
            '已选择'
          ) : (
            '就按这个方向'
          )}
        </Button>
        <span className="min-w-0 flex-1 text-micro leading-snug text-text-tertiary">
          {voided ? '已作废' : settled ? '已开始生成' : ''}
        </span>
      </div>
    </div>
  )
}
