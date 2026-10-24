import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Loader2, RotateCcw, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InferredParams } from '@/lib/api/generate'

interface ParamPanelProps {
  /** 当前推断结果（null = 还没算出来） */
  value: InferredParams | null
  /** 推断请求进行中 */
  loading?: boolean
  /** 用户手动指定画幅 / 尺寸 */
  onChange: (next: { aspect?: string; size?: string }) => void
  /** 恢复自动识别 */
  onReset: () => void
  /** 是否有手动覆盖 */
  manual: boolean
  className?: string
}

const SOURCE_LABEL: Record<string, string> = {
  manual: '手动',
  text: '按文本',
  scene: '按场景',
  fallback: '通用',
  source: '跟随原图',
}

/**
 * 参数面板：折叠态一行、展开态一组。
 *
 * 设计取舍：
 * - 默认**折叠**，因为大多数用户不关心像素，只关心「别给我正方形」；
 * - 折叠态必须把「系统会按什么出图」写清楚（比例 + 尺寸 + 依据），
 *   否则用户没有理由信任它，展开后也不会相信那些 chip；
 * - 手动改过之后，文本再变也不再自动覆盖（`manual=true`），
 *   但会提示「已手动锁定」并提供一键恢复自动。
 */
export function ParamPanel({
  value,
  loading,
  onChange,
  onReset,
  manual,
  className,
}: ParamPanelProps) {
  const [open, setOpen] = useState(false)
  const [draftW, setDraftW] = useState('')
  const [draftH, setDraftH] = useState('')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!value) return
    setDraftW(String(value.width))
    setDraftH(String(value.height))
  }, [value?.width, value?.height])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const options = value?.options ?? []
  const ratio = value?.aspect ?? '—'
  const px = value ? `${value.width}×${value.height}` : '—'
  const source = value ? SOURCE_LABEL[value.source] ?? '自动' : '自动'
  const hint = useMemo(() => {
    if (!value) return '正在识别画幅…'
    if (value.locked) return value.reason
    if (manual) return `已手动锁定 ${value.aspect}`
    return value.reason
  }, [value, manual])

  const commitSize = (w: string, h: string) => {
    const width = Number(w)
    const height = Number(h)
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (width < 256 || height < 256 || width > 4096 || height > 4096) return
    onChange({ size: `${Math.round(width)}x${Math.round(height)}` })
  }

  const scheduleCommit = (w: string, h: string) => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => commitSize(w, h), 500)
  }

  return (
    <div
      className={cn(
        'rounded-md bg-surface/70 ring-1 ring-inset ring-border-faint backdrop-blur',
        className
      )}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={hint}
        >
          <Wand2 size={12} className="shrink-0 text-brand-text" />
          <span className="shrink-0 text-micro font-medium tabular-nums text-text">{ratio}</span>
          <span className="shrink-0 text-micro tabular-nums text-text-tertiary">{px}</span>
          <span className="truncate text-micro text-text-faint">· {source}</span>
          {loading && <Loader2 size={10} className="shrink-0 animate-spin text-text-faint" />}
          <ChevronDown
            size={12}
            className={cn(
              'ml-auto shrink-0 text-text-tertiary transition-transform duration-200',
              open && 'rotate-180'
            )}
          />
        </button>
        {manual && (
          <button
            type="button"
            onClick={onReset}
            title="恢复自动识别"
            className="flex h-5 items-center gap-1 rounded-full px-1.5 text-micro text-text-tertiary transition-colors hover:bg-bg-subtle hover:text-text"
          >
            <RotateCcw size={10} /> 自动
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-border-faint px-2 py-2">
          <div className="flex flex-wrap gap-1">
            {options.map((item) => {
              const active = value?.aspect === item.aspect
              return (
                <button
                  key={item.aspect}
                  type="button"
                  onClick={() => onChange({ aspect: item.aspect })}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-micro tabular-nums transition-colors',
                    active
                      ? 'bg-brand text-text-inverse'
                      : 'bg-bg-subtle text-text-secondary hover:bg-surface-hover'
                  )}
                  title={`${item.label} · ${item.width}×${item.height}`}
                >
                  {item.aspect}
                </button>
              )
            })}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <label className="flex items-center gap-1 text-micro text-text-tertiary">
              宽
              <input
                value={draftW}
                onChange={(e) => {
                  setDraftW(e.target.value.replace(/\D/g, '').slice(0, 4))
                  scheduleCommit(e.target.value.replace(/\D/g, ''), draftH)
                }}
                inputMode="numeric"
                className="h-6 w-[52px] rounded-xs bg-bg-subtle px-1.5 text-micro tabular-nums text-text focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </label>
            <span className="text-micro text-text-faint">×</span>
            <label className="flex items-center gap-1 text-micro text-text-tertiary">
              高
              <input
                value={draftH}
                onChange={(e) => {
                  setDraftH(e.target.value.replace(/\D/g, '').slice(0, 4))
                  scheduleCommit(draftW, e.target.value.replace(/\D/g, ''))
                }}
                inputMode="numeric"
                className="h-6 w-[52px] rounded-xs bg-bg-subtle px-1.5 text-micro tabular-nums text-text focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </label>
            {value?.exact === false && (
              <span className="ml-auto text-micro text-text-faint">按最接近的上游档位出图</span>
            )}
          </div>

          <p className="mt-1.5 line-clamp-2 text-micro leading-relaxed text-text-faint">{hint}</p>
        </div>
      )}
    </div>
  )
}
