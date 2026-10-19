import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { EditRegion } from '../edit-draft'
import { HANDLE_CURSOR, RESIZE_HANDLES, type ResizeHandle } from './region-geometry'

/** 拖动多少像素才算「拖」而不是「点」（手指抖动比鼠标大） */
const DRAG_SLOP_FINE = 4
const DRAG_SLOP_COARSE = 10

export type RegionTransformMode = 'move' | 'resize'

interface RegionOverlayProps {
  item: EditRegion
  index: number
  /** 图片在屏幕上的显示尺寸：把像素位移换算成归一化位移 */
  box: { w: number; h: number }
  active: boolean
  hovered: boolean
  /** 正在拖这个区域（期间隐藏删除键、显示尺寸） */
  transforming: boolean
  /** 原图像素尺寸：尺寸标签显示的是「原图上的多少像素」，而不是屏幕像素 */
  natural: { w: number; h: number }
  disabled?: boolean
  onActivate: (id: string) => void
  onHover: (id: string | null) => void
  onTransform: (
    id: string,
    mode: RegionTransformMode,
    handle: ResizeHandle | null,
    dx: number,
    dy: number
  ) => void
  onTransformEnd: () => void
  onDelete: (id: string) => void
}

/**
 * 单个选区的交互外壳：编号徽章（拖动 = 移动，单击 = 写说明）、删除键、缩放把手。
 *
 * 选区「身体」刻意不接管指针：用户经常要在一个大框里再框一个小框，
 * 身体一旦可拖就再也画不进去。所以移动只挂在徽章上，徽章用 grab 光标 + hover 放大
 * 暗示「它能拖」；缩放把手只在激活/悬停时出现，避免满屏小方块。
 */
export function RegionOverlay({
  item,
  index,
  box,
  active,
  hovered,
  transforming,
  natural,
  disabled,
  onActivate,
  onHover,
  onTransform,
  onTransformEnd,
  onDelete,
}: RegionOverlayProps) {
  const { t } = useTranslation('edit')
  const badgeRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    x: number
    y: number
    mode: RegionTransformMode
    handle: ResizeHandle | null
    moved: boolean
  } | null>(null)

  // 徽章落地：从 0 弹到 1，像一颗图钉按在框角上——让「区域已创建」有一个明确的瞬间
  useLayoutEffect(() => {
    const badge = badgeRef.current
    if (!badge || shouldReduceMotion()) return
    const tween = gsap.fromTo(
      badge,
      { scale: 0, rotate: -40 },
      { scale: 1, rotate: 0, duration: 0.5, ease: 'back.out(2.2)' }
    )
    return () => {
      tween.kill()
    }
  }, [])

  const begin = (
    event: React.PointerEvent<HTMLElement>,
    mode: RegionTransformMode,
    handle: ResizeHandle | null
  ) => {
    if (disabled || event.button !== 0) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      mode,
      handle,
      moved: false,
    }
  }

  const move = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dxPx = event.clientX - drag.x
    const dyPx = event.clientY - drag.y
    if (!drag.moved) {
      const slop = event.pointerType === 'touch' ? DRAG_SLOP_COARSE : DRAG_SLOP_FINE
      if (Math.hypot(dxPx, dyPx) < slop) return
      drag.moved = true
    }
    onTransform(item.id, drag.mode, drag.handle, dxPx / (box.w || 1), dyPx / (box.h || 1))
  }

  const end = (event: React.PointerEvent<HTMLElement>, cancelled = false) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    event.stopPropagation()
    if (drag.moved) onTransformEnd()
    else if (!cancelled && drag.mode === 'move') onActivate(item.id)
  }

  /** 删除前先让整块缩走，再真正删——瞬间消失会让人怀疑「是不是点错了别的」 */
  const remove = () => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) {
      onDelete(item.id)
      return
    }
    gsap.to(root, {
      scale: 0.85,
      autoAlpha: 0,
      duration: 0.18,
      ease: 'power2.in',
      transformOrigin: '50% 50%',
      onComplete: () => onDelete(item.id),
    })
  }

  const showHandles = item.kind === 'rect' && !item.path && (active || hovered) && !disabled
  const pxW = Math.round(item.region.w * natural.w)
  const pxH = Math.round(item.region.h * natural.h)

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute z-20"
      style={{
        left: `${item.region.x * 100}%`,
        top: `${item.region.y * 100}%`,
        width: `${item.region.w * 100}%`,
        height: `${item.region.h * 100}%`,
      }}
    >
      <button
        ref={badgeRef}
        type="button"
        data-edit-layer-ui
        title={t('region.badge_hint')}
        aria-label={t('region.badge_label', { index: index + 1 })}
        onPointerDown={(event) => begin(event, 'move', null)}
        onPointerMove={move}
        onPointerUp={(event) => end(event)}
        onPointerCancel={(event) => end(event, true)}
        onPointerEnter={() => onHover(item.id)}
        onPointerLeave={() => onHover(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onActivate(item.id)
          }
        }}
        className={cn(
          'cs-region-badge pointer-events-auto absolute -left-3 -top-3 flex h-6 w-6 touch-none items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-white shadow-md',
          transforming ? 'cursor-grabbing' : 'cursor-grab',
          active ? 'bg-[rgb(220,38,38)] ring-2 ring-[rgba(220,38,38,0.35)]' : 'bg-[rgba(220,38,38,0.95)]'
        )}
      >
        {index + 1}
      </button>

      {!transforming && (
        <button
          type="button"
          title={t('region.delete')}
          aria-label={t('region.delete_label', { index: index + 1 })}
          className={cn(
            'pointer-events-auto absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full border border-white bg-black/70 text-white transition-[opacity,background-color,transform] duration-150 hover:scale-110 hover:bg-danger',
            // 只在悬停/激活时完全显形：常驻的一排小 ✕ 很吵，也容易误删
            active || hovered ? 'opacity-100' : 'opacity-0 pointer-coarse:opacity-100'
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerEnter={() => onHover(item.id)}
          onPointerLeave={() => onHover(null)}
          onClick={remove}
        >
          <X size={11} />
        </button>
      )}

      {showHandles &&
        RESIZE_HANDLES.map((handle) => (
          <span
            key={handle}
            data-edit-layer-ui
            role="presentation"
            onPointerDown={(event) => begin(event, 'resize', handle)}
            onPointerMove={move}
            onPointerUp={(event) => end(event)}
            onPointerCancel={(event) => end(event, true)}
            onPointerEnter={() => onHover(item.id)}
            onPointerLeave={() => onHover(null)}
            className={cn('cs-region-handle pointer-events-auto absolute touch-none', `cs-h-${handle}`)}
            style={{ cursor: HANDLE_CURSOR[handle] }}
          />
        ))}

      {transforming && pxW > 0 && (
        <span className="cs-dim-label absolute -bottom-7 right-0 whitespace-nowrap">
          {pxW} × {pxH}
        </span>
      )}
    </div>
  )
}
