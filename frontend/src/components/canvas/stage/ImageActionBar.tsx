import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Columns2,
  Copy,
  Download,
  Ellipsis,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Plus,
  RotateCw,
  Scissors,
  Shuffle,
  SquareDashedMousePointer,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { LineageOp } from './lineage'

export interface ImageActionBarProps {
  /** 选中图片在画布卡片内的屏幕矩形 */
  rect: { x: number; y: number; w: number; h: number }
  /** 换了一张图才重播入场（同一张图平移缩放只跟随位置） */
  targetKey: string
  /** 原图尺寸（展示用） */
  naturalSize?: { width: number; height: number } | null
  version: number
  canCompare: boolean
  /** 正在提交的一键操作（按钮转圈并禁用，防止连点重复扣费） */
  busy: LineageOp | null
  /** 单次编辑的额度单价（写在提示里：一键操作也花额度，用户要知道） */
  cost: number
  onEdit: () => void
  onEnhance: () => void
  onCutout: () => void
  onVariation: () => void
  onResize: (factor: number) => void
  onCompare: () => void
  onDownload: (format: 'png' | 'jpg') => void
  onReference: () => void
  onCopy: () => void
  onDelete: () => void
  /** 顺时针旋转 90°（本地操作，不扣额度） */
  onRotate?: () => void
  /** 收进团队 / 个人素材库（本地操作，不扣额度） */
  onAddToLibrary?: () => void
  /** 正在加入素材库 */
  addingToLibrary?: boolean
}

/** 操作条与图片的间距：拉开一些，别压在图片边缘、挡住视线 */
const GAP = 28
const EDGE = 8

/**
 * 选中图片的浮动操作条（对标 Lovart：快捷编辑 / 放大 / 去背景 / … / 下载）。
 *
 * 为什么贴着图片而不是放在固定工具栏：用户的视线此刻就在这张图上，
 * 「对它能做什么」应该出现在视线落点，而不是让人去屏幕角落找。
 *
 * 定位：默认在图片上方居中；上方放不下就翻到下方；两侧夹在画布卡片内。
 * 位置用 transform 写（GSAP set），平移/缩放画布时逐帧跟随也不触发布局。
 */
export function ImageActionBar({
  rect,
  targetKey,
  naturalSize,
  version,
  canCompare,
  busy,
  cost,
  onEdit,
  onEnhance,
  onCutout,
  onVariation,
  onResize,
  onCompare,
  onDownload,
  onReference,
  onCopy,
  onDelete,
  onRotate,
  onAddToLibrary,
  addingToLibrary,
}: ImageActionBarProps) {
  const { t } = useTranslation('stage')
  const barRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)

  // 跟随：每次矩形变化重新算位置
  useLayoutEffect(() => {
    const bar = barRef.current
    const host = bar?.offsetParent as HTMLElement | null
    if (!bar || !host) return
    const hostW = host.clientWidth
    const hostH = host.clientHeight
    // 只有主操作保留短标签，其余操作用带提示的图标，避免长操作条遮住画布。
    setCompact(hostW < 420)
    const barW = bar.offsetWidth
    const barH = bar.offsetHeight
    const clampX = (x: number) => Math.min(Math.max(EDGE, x), Math.max(EDGE, hostW - barW - EDGE))
    const clampY = (y: number) => Math.min(Math.max(EDGE, y), Math.max(EDGE, hostH - barH - EDGE))
    const centerX = rect.x + rect.w / 2 - barW / 2
    const centerY = rect.y + rect.h / 2 - barH / 2
    // 上下空间不足时优先放到左右空白处，尽量保持与图片的安全间距。
    const positions = [
      { left: clampX(centerX), top: rect.y - barH - GAP },
      { left: clampX(centerX), top: rect.y + rect.h + GAP },
      { left: rect.x + rect.w + GAP, top: clampY(centerY) },
      { left: rect.x - barW - GAP, top: clampY(centerY) },
    ]
    const position = positions.find(({ left, top }) =>
      left >= EDGE && top >= EDGE && left + barW <= hostW - EDGE && top + barH <= hostH - EDGE
    ) ?? { left: clampX(centerX), top: rect.y > hostH / 2 ? EDGE : clampY(hostH - barH - EDGE) }
    const { left, top } = position
    gsap.set(bar, { x: Math.round(left), y: Math.round(top) })
  }, [rect.x, rect.y, rect.w, rect.h, compact])

  // 入场：换一张图才播放（同一张图拖动/缩放时不该反复弹）
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    if (shouldReduceMotion()) {
      gsap.set(bar, { autoAlpha: 1 })
      return
    }
    const tween = gsap.fromTo(
      bar,
      { autoAlpha: 0, scale: 0.94, transformOrigin: '50% 100%' },
      { autoAlpha: 1, scale: 1, duration: 0.36, ease: 'back.out(1.8)' }
    )
    const items = bar.querySelectorAll('[data-bar-item]')
    const stagger = gsap.fromTo(
      items,
      { autoAlpha: 0, y: 4 },
      { autoAlpha: 1, y: 0, duration: 0.28, stagger: 0.025, ease: 'power2.out', delay: 0.04 }
    )
    return () => {
      tween.kill()
      stagger.kill()
    }
  }, [targetKey])

  const costHint = t('bar.cost', { cost })

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t('bar.label')}
      // 编辑层的「点图片」判定会跳过这里，避免点按钮被当成点图
      data-edit-layer-ui
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-auto invisible absolute left-0 top-0 z-30 flex max-w-[calc(100%-16px)] items-center gap-px rounded-[10px] bg-surface-raised/70 p-[3px] opacity-0 shadow-sheet ring-1 ring-border/70 backdrop-blur-xl"
    >
      <span
        data-bar-item
        className="mr-0.5 flex h-[26px] shrink-0 items-center gap-1 rounded-[7px] bg-bg-subtle/70 px-1.5 text-[10px] font-semibold tabular-nums text-text-secondary"
        title={naturalSize ? `${naturalSize.width} × ${naturalSize.height}` : undefined}
      >
        <span className={cn(version > 1 && 'text-accent-ink')}>V{version}</span>
      </span>

      <BarButton compact label={t('bar.shrink')} hint={t('bar.shrink_hint')} onClick={() => onResize(0.85)}>
        <ZoomOut size={14} />
      </BarButton>
      <BarButton compact label={t('bar.enlarge')} hint={t('bar.enlarge_hint')} onClick={() => onResize(1.18)}>
        <Plus size={14} />
      </BarButton>
      <span data-bar-item aria-hidden className="mx-0.5 h-4 w-px bg-border" />

      <BarButton compact={compact} label={t('bar.edit')} hint={t('bar.edit_hint')} onClick={onEdit} primary>
        <SquareDashedMousePointer size={14} />
      </BarButton>
      <BarButton
        compact
        label={t('bar.enhance')}
        hint={`${t('bar.enhance_hint')} · ${costHint}`}
        onClick={onEnhance}
        loading={busy === 'enhance'}
        disabled={busy !== null}
      >
        <ZoomIn size={14} />
      </BarButton>
      <BarButton
        compact
        label={t('bar.cutout')}
        hint={`${t('bar.cutout_hint')} · ${costHint}`}
        onClick={onCutout}
        loading={busy === 'cutout'}
        disabled={busy !== null}
      >
        <Scissors size={14} />
      </BarButton>
      <BarButton
        compact
        label={t('bar.variation')}
        hint={t('bar.variation_hint')}
        onClick={onVariation}
        loading={busy === 'variation'}
        disabled={busy !== null}
      >
        <Shuffle size={14} />
      </BarButton>
      <span data-bar-item aria-hidden className="mx-0.5 h-4 w-px bg-border" />

      {onRotate && (
        <BarButton compact label="旋转" hint="顺时针旋转 90°（不消耗额度）" onClick={onRotate}>
          <RotateCw size={14} />
        </BarButton>
      )}
      {onAddToLibrary && (
        <BarButton
          compact
          label="收进素材库"
          hint="保存到素材库，之后可复用（不消耗额度）"
          onClick={onAddToLibrary}
          loading={addingToLibrary}
        >
          <FolderPlus size={14} />
        </BarButton>
      )}

      <BarButton compact label={t('bar.download')} hint={t('bar.download_hint')} onClick={() => onDownload('png')}>
        <Download size={14} />
      </BarButton>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-bar-item
                aria-label={t('bar.more')}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Ellipsis size={14} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t('bar.more')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-48" data-edit-layer-ui>
          <DropdownMenuItem onClick={onReference}>
            <MessageSquarePlus size={14} /> {t('bar.reference')}
          </DropdownMenuItem>
          {canCompare && (
            <DropdownMenuItem onClick={onCompare}>
              <Columns2 size={14} /> {t('bar.compare')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onCopy}>
            <Copy size={14} /> {t('bar.copy')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onDownload('jpg')}>
            <Download size={14} /> {t('bar.download_jpg')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="text-danger focus:text-danger">
            <Trash2 size={14} /> {t('bar.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function BarButton({
  label,
  hint,
  onClick,
  compact,
  primary,
  loading,
  disabled,
  children,
}: {
  label: string
  hint: string
  onClick: () => void
  compact: boolean
  primary?: boolean
  loading?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-bar-item
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-busy={loading}
          className={cn(
            'flex h-[26px] shrink-0 items-center gap-1 rounded-[7px] text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'w-[26px] justify-center' : 'px-1.5',
            primary
              ? 'bg-accent-soft text-accent-ink hover:bg-accent/40'
              : 'text-text-secondary hover:bg-surface-hover hover:text-text'
          )}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : children}
          {!compact && <span>{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>{compact ? `${label} · ${hint}` : hint}</TooltipContent>
    </Tooltip>
  )
}
