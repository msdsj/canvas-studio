import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight,
  Brush,
  Circle,
  Eraser,
  Frame,
  Hash,
  Keyboard,
  Lasso,
  Loader2,
  LogOut,
  PenLine,
  Redo2,
  Sparkles,
  Square,
  SquareDashed,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

export type EditTool = 'region' | 'lasso' | 'brush' | 'pen' | 'border' | 'marker' | 'eraser'

/** 工具分两组：「选区」决定改哪里（会生成指令气泡）；「标注」只是给 AI 的视觉提示 */
const SELECT_TOOLS: Array<{ id: EditTool; icon: typeof Frame; key: string }> = [
  { id: 'region', icon: Frame, key: 'R' },
  { id: 'lasso', icon: Lasso, key: 'L' },
  { id: 'brush', icon: Brush, key: 'B' },
]
const MARK_TOOLS: Array<{ id: EditTool; icon: typeof Frame; key: string }> = [
  { id: 'pen', icon: PenLine, key: 'P' },
  { id: 'border', icon: SquareDashed, key: 'F' },
  { id: 'marker', icon: ArrowUpRight, key: 'M' },
  { id: 'eraser', icon: Eraser, key: 'E' },
]

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

interface EditToolbarProps {
  tool: EditTool
  onToolChange: (tool: EditTool) => void
  colors: string[]
  color: string
  onColor: (color: string) => void
  sizes: Array<{ label: string; value: number }>
  size: number
  onSize: (size: number) => void
  borderShape: 'rect' | 'ellipse'
  onBorderShape: (shape: 'rect' | 'ellipse') => void
  markerShape: 'arrow' | 'index' | 'label'
  onMarkerShape: (shape: 'arrow' | 'index' | 'label') => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  canClear: boolean
  onClear: () => void
  regionCount: number
  filledCount: number
  markCount: number
  canSubmit: boolean
  submitting: boolean
  onSubmit: () => void
  onExit: () => void
  onDeleteImage?: () => void
  /** 递增即让当前工具按钮「闪一下」：用于「重画」后把视线引回工具条 */
  pulseToken?: number
}

/**
 * 编辑模式顶部工具条（对标 Lovart 选中图片后的浮动条）。
 *
 * 信息层级从左到右：选什么工具 → 工具参数（只在相关时出现）→ 撤销/重做 → 主操作。
 * 原来所有参数常驻、用透明度表示「不可用」，一行塞了 20 多个控件；
 * 现在参数跟着工具出现，主按钮写清「提交修改（N 处）」，普通用户一眼知道下一步。
 *
 * 当前工具底下是一枚滑动胶囊（GSAP），切工具时它滑过去，而不是瞬间换底色——
 * 视线会跟着它走，用户能确认「切到了哪个」。
 */
export function EditToolbar(props: EditToolbarProps) {
  const {
    tool,
    onToolChange,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    regionCount,
    filledCount,
    canSubmit,
    submitting,
    onSubmit,
    onExit,
    onDeleteImage,
    pulseToken,
  } = props
  const { t } = useTranslation('edit')
  const groupRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const firstRef = useRef(true)

  // 滑动胶囊：位置跟随当前工具；工具条换行/标签隐藏导致按钮挪位时同步瞬移
  useLayoutEffect(() => {
    const group = groupRef.current
    const pill = pillRef.current
    if (!group || !pill) return
    const place = (animate: boolean) => {
      const target = group.querySelector<HTMLElement>(`[data-tool="${tool}"]`)
      if (!target) return
      const vars = {
        x: target.offsetLeft,
        y: target.offsetTop,
        width: target.offsetWidth,
        height: target.offsetHeight,
      }
      if (!animate || shouldReduceMotion()) gsap.set(pill, vars)
      else gsap.to(pill, { ...vars, duration: 0.42, ease: 'csSnap', overwrite: 'auto' })
    }
    place(!firstRef.current)
    firstRef.current = false
    const ro = new ResizeObserver(() => place(false))
    ro.observe(group)
    return () => ro.disconnect()
  }, [tool])

  // 「重画」后让当前工具按钮弹一下，提示用户「直接在图上重新画」
  useLayoutEffect(() => {
    if (!pulseToken || shouldReduceMotion()) return
    const target = groupRef.current?.querySelector<HTMLElement>(`[data-tool="${tool}"]`)
    if (!target) return
    gsap.fromTo(target, { scale: 1 }, { scale: 1.18, duration: 0.16, yoyo: true, repeat: 3, ease: 'power1.inOut' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseToken])

  // 有可提交内容时主按钮「亮一下」：从灰到可点的那一刻要被看见
  const readyRef = useRef(false)
  useLayoutEffect(() => {
    const ready = canSubmit && !submitting
    if (ready && !readyRef.current && submitRef.current && !shouldReduceMotion()) {
      gsap.fromTo(
        submitRef.current,
        { scale: 0.92 },
        { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.45)' }
      )
    }
    readyRef.current = ready
  }, [canSubmit, submitting])

  const renderTool = (item: { id: EditTool; icon: typeof Frame; key: string }) => {
    const Icon = item.icon
    const active = tool === item.id
    return (
      <button
        key={item.id}
        type="button"
        data-tool={item.id}
        aria-pressed={active}
        onClick={() => onToolChange(item.id)}
        title={`${t(`tool.${item.id}.label`)} (${item.key}) — ${t(`tool.${item.id}.hint`)}`}
        className={cn(
          'relative z-[1] inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors duration-200',
          active ? 'text-text' : 'text-text-tertiary hover:text-text-secondary'
        )}
      >
        <Icon size={13} />
        <span className="hidden md:inline">{t(`tool.${item.id}.label`)}</span>
      </button>
    )
  }

  return (
    <div
      data-edit-surface="toolbar"
      className="pointer-events-auto absolute left-1/2 top-14 z-40 mt-2 flex max-w-[calc(100%-16px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-[18px] bg-surface/95 p-1 shadow-float ring-1 ring-border-faint backdrop-blur-md"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* 工具组 */}
      <div ref={groupRef} role="radiogroup" aria-label={t('toolbar.tools')} className="relative flex items-center gap-0.5 rounded-full bg-bg-subtle p-0.5">
        <span
          ref={pillRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 rounded-full bg-surface shadow-xs ring-1 ring-inset ring-border-faint"
        />
        {SELECT_TOOLS.map(renderTool)}
        <span aria-hidden className="relative z-[1] mx-0.5 h-4 w-px bg-border" />
        {MARK_TOOLS.map(renderTool)}
      </div>

      <ToolOptions {...props} />

      <Divider />

      {/* 撤销 / 重做：不再只管涂鸦，选区、标注、画笔共用一条历史 */}
      <IconAction label={t('toolbar.undo')} shortcut={`${MOD_KEY} Z`} disabled={!canUndo} onClick={onUndo}>
        <Undo2 size={14} />
      </IconAction>
      <IconAction
        label={t('toolbar.redo')}
        shortcut={IS_MAC ? '⇧⌘ Z' : 'Ctrl Y'}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 size={14} />
      </IconAction>

      <ShortcutSheet />

      {onDeleteImage && (
        <IconAction label={t('toolbar.delete_image')} onClick={onDeleteImage} danger>
          <Trash2 size={14} />
        </IconAction>
      )}

      <Divider />

      <button
        type="button"
        onClick={onExit}
        title={t('toolbar.exit_hint')}
        className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
      >
        <LogOut size={13} />
        <span className="hidden sm:inline">{t('toolbar.exit')}</span>
      </button>

      <button
        ref={submitRef}
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit || submitting}
        title={regionCount === 0 ? t('toolbar.submit_empty') : t('toolbar.submit_hint', { count: filledCount })}
        className={cn(
          'relative inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold transition-[filter,background-color,color] duration-200',
          // 不用 .cs-gradient-accent：它是非分层 CSS，会压过 disabled 态的工具类；
          // 文字用 on-accent（青柠实底上恒为深墨），暗色主题下 accent-ink 是浅色会看不清
          canSubmit && !submitting
            ? 'bg-accent text-on-accent shadow-glow hover:brightness-105'
            : 'cursor-not-allowed bg-bg-subtle text-text-faint'
        )}
      >
        {submitting ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
        {submitting
          ? t('toolbar.submitting')
          : filledCount > 0
            ? t('toolbar.submit_count', { count: filledCount })
            : t('toolbar.submit')}
      </button>
    </div>
  )
}

/** 只在相关工具下出现的参数：颜色 / 粗细 / 形状 / 清空标注 */
function ToolOptions({
  tool,
  colors,
  color,
  onColor,
  sizes,
  size,
  onSize,
  borderShape,
  onBorderShape,
  markerShape,
  onMarkerShape,
  canClear,
  onClear,
  markCount,
}: EditToolbarProps) {
  const { t } = useTranslation('edit')
  const colorActive = tool === 'pen' || tool === 'border' || tool === 'marker'
  const sizeActive = tool !== 'region' && tool !== 'lasso'
  const markTool = tool === 'pen' || tool === 'border' || tool === 'marker' || tool === 'eraser'
  if (!colorActive && !sizeActive && !markTool) return null

  return (
    <div className="flex items-center gap-1 pl-1">
      {tool === 'border' && (
        <Segment
          value={borderShape}
          onChange={onBorderShape}
          items={[
            { id: 'rect', icon: <Square size={12} />, label: t('option.rect') },
            { id: 'ellipse', icon: <Circle size={12} />, label: t('option.ellipse') },
          ]}
        />
      )}
      {tool === 'marker' && (
        <Segment
          value={markerShape}
          onChange={onMarkerShape}
          items={[
            { id: 'arrow', icon: <ArrowUpRight size={12} />, label: t('option.arrow') },
            { id: 'index', icon: <Hash size={12} />, label: t('option.index') },
            { id: 'label', icon: <Type size={12} />, label: t('option.label') },
          ]}
        />
      )}
      {colorActive && (
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label={t('option.color')}>
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={t('option.color_value', { value: c })}
              aria-pressed={color === c}
              onClick={() => onColor(c)}
              className={cn(
                'h-5 w-5 rounded-full border transition-transform duration-150 hover:scale-110',
                color === c ? 'scale-110 border-surface ring-2 ring-text/60' : 'border-border'
              )}
              style={{ background: c }}
            />
          ))}
        </div>
      )}
      {sizeActive && (
        <div className="flex items-center gap-0.5" role="radiogroup" aria-label={t('option.size')}>
          {sizes.map((s, index) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={size === s.value}
              title={s.label}
              onClick={() => onSize(s.value)}
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full transition-colors',
                size === s.value ? 'bg-brand-subtle' : 'hover:bg-surface-hover'
              )}
            >
              {/* 直接画出粗细，比「细/中/粗」三个字更直观 */}
              <span
                className="rounded-full bg-text-secondary"
                style={{ width: 4 + index * 3, height: 4 + index * 3 }}
              />
            </button>
          ))}
        </div>
      )}
      {markTool && (
        <button
          type="button"
          disabled={!canClear}
          onClick={onClear}
          title={t('option.clear_marks')}
          className="inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[10px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40"
        >
          <Eraser size={11} />
          <span className="tabular-nums">{markCount}</span>
        </button>
      )}
    </div>
  )
}

function Segment<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T
  onChange: (value: T) => void
  items: Array<{ id: T; icon: ReactNode; label: string }>
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-bg-subtle p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          title={item.label}
          aria-label={item.label}
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full transition-colors',
            value === item.id ? 'bg-surface text-text shadow-xs' : 'text-text-tertiary hover:text-text'
          )}
        >
          {item.icon}
        </button>
      ))}
    </div>
  )
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
}

function IconAction({
  label,
  shortcut,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-[background-color,color,opacity] duration-150 active:scale-95',
        danger ? 'hover:bg-danger-subtle hover:text-danger' : 'hover:bg-surface-hover hover:text-text',
        'disabled:pointer-events-none disabled:opacity-30'
      )}
    >
      {children}
    </button>
  )
}

/** 快捷键速查：普通用户不会去背快捷键，但会在需要时点开看一眼 */
function ShortcutSheet() {
  const { t } = useTranslation('edit')
  const rows: Array<[string, string]> = [
    ['R / L / B', t('keys.select_tools')],
    ['P / F / M / E', t('keys.mark_tools')],
    [`${MOD_KEY} Z`, t('keys.undo')],
    [IS_MAC ? '⇧⌘ Z' : 'Ctrl Y', t('keys.redo')],
    ['Enter', t('keys.confirm')],
    ['Esc', t('keys.cancel')],
    ['Delete', t('keys.delete')],
  ]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('keys.title')}
          title={t('keys.title')}
          className="hidden h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text sm:flex"
        >
          <Keyboard size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <p className="mb-2 text-caption font-semibold text-text">{t('keys.title')}</p>
        <dl className="flex flex-col gap-1.5">
          {rows.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between gap-3 text-micro">
              <dt className="text-text-secondary">{label}</dt>
              <dd className="shrink-0 rounded-[6px] bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text">
                {keys}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}
