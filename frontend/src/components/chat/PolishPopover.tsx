import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Loader2, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { aiApi, POLISH_MODES, type PolishMode, type PolishResult, type PolishStrength } from '@/lib/api/ai'
import { ApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'

interface PolishPopoverProps {
  /** 当前文本（空则禁用） */
  text: string
  scene: 'composer' | 'region' | 'sidebar'
  /** 应用润色结果：直接覆盖对应输入框 */
  onApply: (text: string) => void
  disabled?: boolean
  /** 技能 id / 画幅等线索，让润色跟出图方向一致 */
  context?: Record<string, unknown>
  /** label=带文字的按钮（页面右上角）；icon=小图标（框选气泡里） */
  variant?: 'label' | 'icon'
  className?: string
}

/** 后端守卫前缀：这些 note 说明的是「保真结论」，不是「改了什么」。 */
const GUARD_PREFIX = '已守护'
const ROLLBACK_PREFIX = '已回退'

/** 把「已守护：xxx」这类结论从 notes 里拆出来，正文只展示「改了什么」。 */
function splitNotes(notes: string[]) {
  const fidelity: string[] = []
  const changes: string[] = []
  for (const note of notes) {
    if (note.startsWith(GUARD_PREFIX) || note.startsWith(ROLLBACK_PREFIX)) fidelity.push(note)
    else changes.push(note)
  }
  return {
    fidelity,
    changes,
    rolledBack: fidelity.some((note) => note.startsWith(ROLLBACK_PREFIX)),
  }
}

/**
 * 极轻量的「差异片段」：找出变体里原文没有的连续片段，按顺序标出来。
 * 不做 LCS：润色结果通常是「原句 + 新增修饰」，用分句级包含判断就够，
 * 也能避免 diff 视图把用户的注意力从「意图」拉到「字符」上。
 */
function addedFragments(original: string, candidate: string): string[] {
  const src = original.trim()
  const out = candidate.trim()
  if (!src || !out || src === out) return []
  const parts = out.split(/[，,；;。.、\n]+/).map((part) => part.trim()).filter(Boolean)
  return parts.filter((part) => part && !src.includes(part))
}

/**
 * 润色面板：一个入口 + 6 种模式 + 2 个方向不同的版本。
 *
 * 为什么不是「点一下就换句话」：用户缺的往往不是措辞，而是「该补什么」。
 * 所以把动作拆开（更具体 / 更专业 / 更简洁 / 英文 / 修歧义），
 * 一次给两个版本，并说明每个版本改了什么——用户能判断，而不是盲选。
 *
 * 保真优先：后端会回传「已守护 / 已回退」结论，这里用青柠色标出来，
 * 并把变体相对原文**新增**的片段单独列出，用户一眼能看到模型有没有加戏。
 *
 * 结果**直接覆盖**输入框；采用后仍可一键撤销。
 */
export function PolishPopover({
  text,
  scene,
  onApply,
  disabled,
  context,
  variant = 'label',
  className,
}: PolishPopoverProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PolishMode>('auto')
  /** 润色强度：轻度=只补细节；专业=优化表达（默认） */
  const [strength, setStrength] = useState<PolishStrength>('pro')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<PolishResult | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 被替换掉的原文：用于撤销 */
  const [replacedFrom, setReplacedFrom] = useState<string | null>(null)

  const empty = !text.trim()
  const blocked = disabled || empty

  const run = useCallback(
    async (nextMode: PolishMode, nextStrength: PolishStrength = strength) => {
      if (!text.trim()) return
      setLoading(true)
      setError(null)
      setResult(null)
      setSelected(null)
      try {
        const data = await aiApi.polish({
          text,
          scene,
          mode: nextMode,
          variants: 2,
          context,
          strength: nextStrength,
        })
        setResult(data)
        setSelected(data.variants[0]?.id ?? null)
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '润色失败，稍后再试')
      } finally {
        setLoading(false)
      }
    },
    [text, scene, context, strength]
  )

  // 打开即按当前模式跑一次：用户点开就能看到结果，少一次点击
  useEffect(() => {
    if (open) void run(mode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const changeMode = (next: PolishMode) => {
    setMode(next)
    void run(next)
  }

  const changeStrength = (next: PolishStrength) => {
    if (next === strength) return
    setStrength(next)
    void run(mode, next)
  }

  const apply = () => {
    const chosen = result?.variants.find((item) => item.id === selected)
    if (!chosen) return
    setReplacedFrom(text)
    onApply(chosen.text)
  }

  const undo = () => {
    if (replacedFrom === null) return
    onApply(replacedFrom)
    setReplacedFrom(null)
  }

  /** 当前选中版本的解析结果：保真结论 / 改动说明 / 新增片段 */
  const active = useMemo(() => {
    const chosen = result?.variants.find((item) => item.id === selected)
    if (!chosen || !result) return null
    const original = result.original || text
    return {
      ...splitNotes(chosen.notes),
      added: addedFragments(original, chosen.text),
      untouched: original === chosen.text,
    }
  }, [result, selected, text])

  const trigger =
    variant === 'icon' ? (
      <button
        type="button"
        disabled={blocked}
        title="润色这段描述"
        aria-label="润色这段描述"
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-text-tertiary transition-colors',
          'hover:bg-brand-subtle hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-40',
          className
        )}
      >
        <Sparkles size={13} />
      </button>
    ) : (
      <button
        type="button"
        disabled={blocked}
        title={blocked ? '先写一句提示词' : '润色提示词'}
        className={cn(
          'inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-micro text-text-secondary transition-colors',
          'hover:bg-brand-subtle hover:text-brand-text disabled:cursor-not-allowed disabled:opacity-40',
          className
        )}
      >
        <Sparkles size={12} />
        润色
        <ChevronDown size={10} className="text-text-tertiary" />
      </button>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="z-[1150] w-[380px] max-w-[calc(100vw-24px)] p-0"
        // 标记为「编辑层浮层」：区域气泡的「点外部即收起」据此放行，
        // 否则一点润色面板，气泡就被收掉、面板跟着卸载
        data-edit-surface="popover"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Sparkles size={13} className="shrink-0 text-brand" />
          <span className="text-caption font-medium text-text">润色提示词</span>
          {result && (
            <span className="ml-auto rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro text-text-tertiary">
              {result.engine === 'relay' ? result.model || '中转站' : '本地规则'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-1 border-y border-border-faint px-3 py-2">
          {POLISH_MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.hint}
              onClick={() => changeMode(item.id)}
              className={cn(
                'rounded-full px-2 py-0.5 text-micro transition-colors',
                mode === item.id
                  ? 'bg-brand text-text-inverse'
                  : 'bg-bg-subtle text-text-secondary hover:bg-surface-hover'
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 润色强度：默认「专业」，切到「轻度」只补细节、不许换词 */}
        <div className="flex items-center gap-1 border-b border-border-faint px-3 py-1.5">
          <span className="mr-1 text-micro text-text-tertiary">强度</span>
          {(
            [
              { id: 'light' as const, label: '轻度润色', hint: '只补全细节，尽量保留原句' },
              { id: 'pro' as const, label: '专业润色', hint: '优化表达与术语，主体不变' },
            ]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.hint}
              aria-pressed={strength === item.id}
              onClick={() => changeStrength(item.id)}
              className={cn(
                'rounded-full px-2 py-0.5 text-micro transition-colors',
                strength === item.id
                  ? 'bg-accent-soft text-accent-ink ring-1 ring-inset ring-accent-strong'
                  : 'text-text-tertiary hover:bg-bg-subtle hover:text-text-secondary'
              )}
            >
              {item.label}
            </button>
          ))}
          <span className="ml-auto text-micro text-text-faint">
            {strength === 'light' ? '保守' : '默认'}
          </span>
        </div>

        {/* 保真结论：只在后端明确给了判断时出现，保持信息密度克制 */}
        {!loading && !error && active && (
          <div
            className={cn(
              'flex items-start gap-1.5 border-b border-border-faint px-3 py-1.5 text-micro leading-relaxed',
              active.rolledBack ? 'bg-bg-subtle text-text-secondary' : 'bg-accent-soft text-accent-ink'
            )}
          >
            <ShieldCheck size={11} className="mt-[1px] shrink-0" />
            <span className="min-w-0">
              {active.rolledBack
                ? '这个版本的改动偏离了你的原意，已回退为原文'
                : active.untouched
                  ? '这一版就是原文：没有可安全补的内容'
                  : active.added.length > 0
                    ? `保真：主体与文字未改动，仅新增 ${active.added.length} 处`
                    : '保真：主体与文字未改动'}
            </span>
          </div>
        )}

        <div className="max-h-[300px] overflow-y-auto px-3 py-2">
          {loading && (
            <div className="flex flex-col gap-2">
              {[0, 1].map((index) => (
                <div key={index} className="flex flex-col gap-1.5 rounded-sm p-2.5 shadow-sheet ring-1 ring-inset ring-border-faint">
                  <span className="h-2 w-16 animate-pulse rounded-full bg-bg-subtle" />
                  <span className="h-2 w-full animate-pulse rounded-full bg-bg-subtle" />
                  <span className="h-2 w-3/4 animate-pulse rounded-full bg-bg-subtle" />
                </div>
              ))}
              <span className="flex items-center gap-1.5 text-micro text-text-tertiary">
                <Loader2 size={11} className="animate-spin" /> 正在重写…
              </span>
            </div>
          )}

          {!loading && error && (
            <p className="rounded-sm bg-danger-subtle px-2.5 py-2 text-micro leading-relaxed text-danger">
              {error}
            </p>
          )}

          {!loading && !error && result?.variants.length === 0 && (
            <p className="px-1 py-2 text-micro text-text-tertiary">没有生成可用结果，换个模式再试</p>
          )}

          {!loading && !error && result && (
            <div className="flex flex-col gap-1.5">
              {result.variants.map((item) => {
                const isActive = selected === item.id
                const { fidelity, changes, rolledBack } = splitNotes(item.notes)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelected(item.id)}
                    aria-pressed={isActive}
                    className={cn(
                      'rounded-sm px-2.5 py-2 text-left transition-colors shadow-sheet ring-1 ring-inset',
                      isActive ? 'ring-brand bg-brand-subtle/40' : 'ring-border-faint hover:bg-surface-hover'
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-micro font-medium text-text">{item.label}</span>
                      <span className="text-micro tabular-nums text-text-faint">{item.length} 字</span>
                      {fidelity.length > 0 && !rolledBack && (
                        <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-micro text-accent-ink">
                          保真
                        </span>
                      )}
                      {rolledBack && (
                        <span className="rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro text-text-tertiary">
                          已回退
                        </span>
                      )}
                      {isActive && <Check size={11} className="ml-auto text-brand" strokeWidth={3} />}
                    </span>
                    <span className="mt-1 block text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
                      {item.text}
                    </span>
                    {changes.length > 0 && (
                      <span className="mt-1 block truncate text-micro text-text-tertiary">
                        {changes.join(' · ')}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 原文对照：只列新增片段，不铺开整段 diff */}
        {!loading && !error && active && !active.rolledBack && active.added.length > 0 && (
          <div className="border-t border-border-faint px-3 py-1.5">
            <p className="text-micro text-text-tertiary">
              相对原文新增
              <span className="ml-1 text-text-faint">（其余内容与原文逐字一致）</span>
            </p>
            <p className="mt-1 max-h-16 overflow-y-auto text-micro leading-relaxed [overflow-wrap:anywhere]">
              {active.added.map((fragment, index) => (
                <span
                  key={`${fragment}-${index}`}
                  className="mr-1 rounded-xs bg-accent-soft px-1 py-px text-accent-ink"
                >
                  {fragment}
                </span>
              ))}
            </p>
          </div>
        )}

        <div className="flex items-center gap-1.5 border-t border-border-faint px-3 py-2">
          {replacedFrom !== null && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-caption" onClick={undo}>
              <RotateCcw size={12} /> 撤销
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            className="ml-auto h-7 px-3 text-caption"
            disabled={loading || !selected}
            onClick={apply}
          >
            {replacedFrom !== null ? '再次采用' : '采用这个版本'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
