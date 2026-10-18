import { useEffect, useState } from 'react'
import { Check, Loader2, Quote, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { VERBATIM_OPTION_ID, type ComposeOption } from '@/lib/api/chat'

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
 * 与「要 1 张还是 2 张」的确认卡不同，这里每个选项代表一个**画面方向**——
 * 用户选中即代表「就按这个方向画」，服务端直接拿去生图，不再二次改写。
 * 选项背后的提示词属中间处理信息，不在这里展示。
 *
 * 选项控件（2026-10-18 重建）：
 * - 弃用「圆点 radio」——在本产品的克制纸面语言里它像浏览器默认控件；
 * - 改为「可整块点选的方案卡」：序号徽标 + 选中态青柠描边/底色 + 末尾对勾；
 * - 第一个选项由服务端排序为最推荐，这里只负责标出「最推荐」，不改顺序。
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
        'rounded-md bg-surface p-3 shadow-sheet',
        voided && 'opacity-60',
        className
      )}
      data-run-id={runId}
      aria-busy={busy}
    >
      <div className="flex items-start gap-2">
        <span className="relative mt-[7px] flex h-1.5 w-1.5 shrink-0 items-center justify-center">
          {/* 暂停态脉冲：明确告诉用户"流程停在这里了"，而不是一个静态提示 */}
          <span className="absolute h-1.5 w-1.5 animate-ping rounded-full bg-warning opacity-70" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-warning" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-micro font-medium text-warning">已暂停，等你选择</p>
          <p className="mt-0.5 text-caption font-medium leading-snug text-text [overflow-wrap:anywhere]">
            {reply}
          </p>
          <p className="mt-0.5 text-micro text-text-tertiary">
            {settled || voided
              ? '这次分析已经结束了'
              : busy
                ? '正在按你选的方案开始…'
                : '选一个方向才会继续生图，我不会替你决定'}
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-col gap-1.5">
        {options.map((option, index) => {
          const isChosen = active === option.id
          // 最后一条固定是「直接用我的原话」：它不是一个"方案"，而是用户的退出权
          const isVerbatim = option.id === VERBATIM_OPTION_ID
          return (
            <div
              key={option.id}
              className={cn(
                'rounded-sm px-2.5 py-2 transition-all',
                isVerbatim && 'border-t border-border-faint pt-2',
                isChosen
                  ? 'bg-accent-soft ring-1 ring-accent-strong'
                  : 'bg-surface ring-1 ring-inset ring-border-faint hover:bg-surface-hover'
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
                    'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-micro font-semibold tabular-nums transition-colors',
                    isChosen ? 'bg-accent text-accent-ink' : 'bg-bg-subtle text-text-tertiary'
                  )}
                >
                  {isChosen ? (
                    <Check size={11} strokeWidth={3} />
                  ) : isVerbatim ? (
                    <Quote size={10} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 text-caption font-medium text-text [overflow-wrap:anywhere]">
                      {option.label}
                    </span>
                    {index === 0 && !isVerbatim && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent/25 px-1.5 py-px text-micro font-medium text-accent-ink">
                        <Sparkles size={9} /> 最推荐
                      </span>
                    )}
                    {isVerbatim && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-bg-subtle px-1.5 py-px text-micro font-medium text-text-tertiary">
                        一字不改
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
                      {option.description}
                    </span>
                  )}
                </span>
              </button>
            </div>
          )
        })}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
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
        <span className="min-w-0 flex-1 text-micro leading-snug text-text-tertiary [overflow-wrap:anywhere]">
          {voided ? '已作废' : settled ? '已开始生成' : active ? '点主按钮才会开始生成' : '先选一个方向'}
        </span>
      </div>
    </div>
  )
}
