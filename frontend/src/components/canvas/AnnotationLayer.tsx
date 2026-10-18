import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { NormRegion } from './canvas-helpers'
import {
  annotationBBox,
  indexBadgeRadius,
  type AnnotationObject,
  type BorderAnnotation,
  type MarkerAnnotation,
  type Pt,
} from './annotations'

/**
 * 标注渲染层（R07 边框 / R08 标记 / R17 拖动 / R19 显隐）。
 *
 * 三条实现约束（踩过的坑，别改回去）：
 *
 * 1. **坐标全部走归一化 0–1**，渲染时才乘 `width/height`。用像素 viewBox
 *    （`0 0 w h`）而不是 `0 0 100 100 + preserveAspectRatio="none"`——
 *    后者会把箭头三角和文字拉伸变形（非等比缩放对 `vectorEffect` 无效）。
 * 2. **`pointer-events` 只在命中区开启**：根节点 `pointer-events-none`，
 *    每个标注补一条透明 hit path（`pointerEvents="stroke"` / `"all"`）。
 *    这样「在已有边框内部再画一个更小的边框」仍然抓得到落笔点——
 *    如果整层都接管指针，内部留白就再也点不进去了。
 * 3. **包围盒预览（纯标注无选区）必须常驻**，不允许点了提交才出现
 *    （PRD §3.1-R07/R09 / D3「不能黑箱」）。
 */

/** 拖动开始后多少屏幕像素才算「真的在拖」（低于此值视为点选） */
const DRAG_SLOP_PX = 2

export interface AnnotationLayerProps {
  /** 标注对象（归一化坐标） */
  items: AnnotationObject[]
  /** 图层容器的 CSS 像素宽高：归一化 → 像素的唯一换算依据 */
  width: number
  height: number
  /** R19：显隐开关（false 时整层不渲染，数据保留） */
  visible: boolean
  onToggleVisible: () => void
  /** 当前选中的标注 id */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** 拖动：`dx/dy` 是**相对拖动起点**的归一化总位移（宿主据此重算对象） */
  onDragStart: (id: string) => void
  onDragMove: (id: string, dx: number, dy: number) => void
  onDragEnd: () => void
  /** 指针被打断（pointercancel）：与 Esc 同一条中止路径 */
  onCancel: () => void
  /** 删除（Delete/Backspace 与右上角删除按钮共用） */
  onDelete: (id: string) => void
  /** 纯标注无选区时的兜底包围盒（提交前一直可见） */
  fallbackBox: NormRegion | null
  /** 原图像素尺寸：尺寸标签按它换算成真实像素 */
  naturalWidth: number
  naturalHeight: number
  /** 提交中：禁用拖动与删除 */
  disabled?: boolean
}

/** 边框的路径（视觉与命中复用同一份几何，避免「看得见点不到」） */
function borderPath(item: BorderAnnotation, w: number, h: number): string {
  const x = item.box.x * w
  const y = item.box.y * h
  const rw = Math.max(1, item.box.w * w)
  const rh = Math.max(1, item.box.h * h)
  if (item.shape === 'ellipse') {
    const rx = rw / 2
    const ry = rh / 2
    const cx = x + rx
    const cy = y + ry
    return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  }
  return `M ${x} ${y} H ${x + rw} V ${y + rh} H ${x} Z`
}

export function AnnotationLayer({
  items,
  width,
  height,
  visible,
  onToggleVisible,
  selectedId,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  onCancel,
  onDelete,
  fallbackBox,
  naturalWidth,
  naturalHeight,
  disabled = false,
}: AnnotationLayerProps) {
  const { t } = useTranslation('canvas')
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; start: Pt; moved: boolean } | null>(null)

  /** 屏幕坐标 → 归一化坐标（与编辑层的 toNorm 口径一致：相对本层容器） */
  const toNorm = useCallback((clientX: number, clientY: number): Pt => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / Math.max(1, rect.height))),
    }
  }, [])

  const beginDrag = (event: React.PointerEvent<SVGElement>, item: AnnotationObject) => {
    if (disabled) return
    // 不让事件冒泡到绘制层：否则「点标注」会同时开始画一个新框
    event.stopPropagation()
    onSelect(item.id)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* 某些浏览器在 pointercancel 后会抛：拖动退化为普通跟随，不影响结果 */
    }
    dragRef.current = { id: item.id, start: toNorm(event.clientX, event.clientY), moved: false }
    onDragStart(item.id)
  }

  const moveDrag = (event: React.PointerEvent<SVGElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const p = toNorm(event.clientX, event.clientY)
    const dx = p.x - drag.start.x
    const dy = p.y - drag.start.y
    if (!drag.moved && Math.hypot(dx * w, dy * h) < DRAG_SLOP_PX) return
    drag.moved = true
    onDragMove(drag.id, dx, dy)
  }

  const endDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    onDragEnd()
  }

  const cancelDrag = () => {
    if (!dragRef.current) return
    dragRef.current = null
    onCancel()
  }

  /**
   * 选中后 Delete/Backspace 删除。
   * 必须 `preventDefault`：Excalidraw 自己也在监听 Backspace（会删掉整张图片元素）。
   * 输入框内的删除交给输入框，不抢。
   */
  useEffect(() => {
    if (!selectedId || disabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (event.isComposing) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      event.preventDefault()
      onDelete(selectedId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, disabled, onDelete])

  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null
  const selectedBox = selected ? annotationBBox(selected) : null

  /** 兜底包围盒的尺寸标签（真实像素：`320 × 180`） */
  const fallbackLabel = fallbackBox
    ? `${Math.round(Math.max(1, naturalWidth) * fallbackBox.w)} × ${Math.round(
        Math.max(1, naturalHeight) * fallbackBox.h
      )}`
    : ''

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-20" data-annotation-layer>
      {/* 标注本体 + 命中区 */}
      {visible && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${w} ${h}`}
          width={w}
          height={h}
          aria-hidden="true"
        >
          {items.map((item) => {
            const lineWidth = Math.max(1.5, item.width * w)
            const selectedNow = selectedId === item.id
            return (
              <g key={item.id} data-annotation-visual data-annotation-kind={item.kind}>
                {/* ---------- 视觉 ---------- */}
                {item.kind === 'border' && (
                  <path
                    d={borderPath(item, w, h)}
                    fill="none"
                    stroke={item.color}
                    strokeWidth={lineWidth}
                    strokeDasharray={item.dash === 'dashed' ? `${lineWidth * 4} ${lineWidth * 3}` : undefined}
                    strokeLinejoin="round"
                  />
                )}
                {item.kind === 'marker' && item.shape === 'arrow' && (
                  <ArrowVisual item={item} w={w} h={h} lineWidth={lineWidth} />
                )}
                {item.kind === 'marker' && item.shape === 'index' && (
                  <IndexVisual item={item} w={w} h={h} />
                )}
                {item.kind === 'marker' && item.shape === 'label' && (
                  <LabelVisual item={item} w={w} h={h} />
                )}
                {/* 涂鸦由编辑层的 canvas 层绘制，这里不重复渲染（否则会出现双重描边） */}
                {item.kind === 'doodle' && null}

                {/* ---------- 命中区（透明，只在几何附近接管指针） ---------- */}
                {item.kind === 'border' && (
                  <path
                    d={borderPath(item, w, h)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(16, lineWidth * 3)}
                    pointerEvents="stroke"
                    style={{ cursor: disabled ? 'default' : 'move' }}
                    onPointerDown={(event) => beginDrag(event, item)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  />
                )}
                {item.kind === 'marker' && item.shape === 'arrow' && (
                  <line
                    x1={item.from.x * w}
                    y1={item.from.y * h}
                    x2={item.to.x * w}
                    y2={item.to.y * h}
                    stroke="transparent"
                    strokeWidth={Math.max(16, lineWidth * 3)}
                    pointerEvents="stroke"
                    style={{ cursor: disabled ? 'default' : 'move' }}
                    onPointerDown={(event) => beginDrag(event, item)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  />
                )}
                {item.kind === 'marker' && item.shape !== 'arrow' && (
                  <circle
                    cx={item.from.x * w}
                    cy={item.from.y * h}
                    r={Math.max(14, indexBadgeRadius(item) * w)}
                    fill="transparent"
                    pointerEvents="all"
                    style={{ cursor: disabled ? 'default' : 'move' }}
                    onPointerDown={(event) => beginDrag(event, item)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  />
                )}
                {item.kind === 'doodle' && (
                  <polyline
                    points={item.points.map((p) => `${p.x * w},${p.y * h}`).join(' ')}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(16, lineWidth * 3)}
                    pointerEvents="stroke"
                    style={{ cursor: disabled ? 'default' : 'move' }}
                    onPointerDown={(event) => beginDrag(event, item)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  />
                )}

                {/* ---------- 选中态：青柠虚线外框（唯一信号色的用法之一） ---------- */}
                {selectedNow && (() => {
                  const box = annotationBBox(item)
                  if (!box) return null
                  return (
                    <rect
                      x={box.x * w}
                      y={box.y * h}
                      width={Math.max(1, box.w * w)}
                      height={Math.max(1, box.h * h)}
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )
                })()}
              </g>
            )
          })}
        </svg>
      )}

      {/* 纯标注无选区：兜底包围盒 + 尺寸标签（D3，提交前一直可见，不参与导出） */}
      {fallbackBox && (
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox={`0 0 ${w} ${h}`}
          width={w}
          height={h}
          aria-hidden="true"
        >
          <rect
            data-fallback-box
            x={fallbackBox.x * w}
            y={fallbackBox.y * h}
            width={Math.max(1, fallbackBox.w * w)}
            height={Math.max(1, fallbackBox.h * h)}
            fill="none"
            stroke="var(--color-select-line)"
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
        </svg>
      )}
      {fallbackBox && (
        <span
          data-fallback-size
          className="absolute z-10 rounded-[6px] bg-surface/85 px-1.5 py-0.5 font-mono text-[12px] leading-none text-text-secondary"
          style={{
            left: `${Math.min(96, (fallbackBox.x + fallbackBox.w) * 100)}%`,
            top: `${Math.min(96, (fallbackBox.y + fallbackBox.h) * 100)}%`,
            transform: 'translate(6px, 6px)',
          }}
        >
          {fallbackLabel}
        </span>
      )}

      {/* 选中对象的删除按钮：贴在包围盒右上角 */}
      {selectedBox && selected && !disabled && (
        <button
          type="button"
          data-annotation-remove={selected.id}
          title={t('annotation.remove', { defaultValue: '删除该标注' })}
          aria-label={t('annotation.remove', { defaultValue: '删除该标注' })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onDelete(selected.id)}
          className="pointer-events-auto absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-surface-raised text-text-secondary shadow-sheet hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          style={{
            left: `${(selectedBox.x + selectedBox.w) * 100}%`,
            top: `${selectedBox.y * 100}%`,
          }}
        >
          <Trash2 size={12} />
        </button>
      )}

      {/* R19 显隐开关：有标注才出现，隐藏后仍留着按钮以便恢复 */}
      {items.length > 0 && (
        <button
          type="button"
          data-annotation-toggle
          aria-pressed={visible}
          title={
            visible
              ? t('annotation.hide', { defaultValue: '隐藏全部标注' })
              : t('annotation.show', { defaultValue: '显示全部标注' })
          }
          aria-label={
            visible
              ? t('annotation.hide', { defaultValue: '隐藏全部标注' })
              : t('annotation.show', { defaultValue: '显示全部标注' })
          }
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onToggleVisible}
          className={cn(
            'pointer-events-auto absolute right-2 top-2 z-20 inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] shadow-sheet',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            visible
              ? 'bg-surface/90 text-text-secondary hover:text-text'
              : 'bg-accent text-accent-ink'
          )}
        >
          {visible ? <Eye size={12} /> : <EyeOff size={12} />}
          <span className="hidden sm:inline">
            {visible
              ? t('annotation.hide', { defaultValue: '隐藏标注' })
              : t('annotation.show', { defaultValue: '显示标注' })}
          </span>
        </button>
      )}
    </div>
  )
}

/** 箭头：白色打底 + 实色线 + 三角头（三角头方向由 from→to 决定） */
function ArrowVisual({
  item,
  w,
  h,
  lineWidth,
}: {
  item: MarkerAnnotation
  w: number
  h: number
  lineWidth: number
}) {
  const fx = item.from.x * w
  const fy = item.from.y * h
  const tx = item.to.x * w
  const ty = item.to.y * h
  const angle = Math.atan2(ty - fy, tx - fx)
  const head = Math.max(9, lineWidth * 4.5)
  const bodyX = tx - Math.cos(angle) * head * 0.9
  const bodyY = ty - Math.sin(angle) * head * 0.9
  const points = [
    `${tx},${ty}`,
    `${tx - Math.cos(angle - Math.PI / 7) * head},${ty - Math.sin(angle - Math.PI / 7) * head}`,
    `${tx - Math.cos(angle + Math.PI / 7) * head},${ty - Math.sin(angle + Math.PI / 7) * head}`,
  ].join(' ')
  return (
    <g>
      <line x1={fx} y1={fy} x2={bodyX} y2={bodyY} stroke="rgba(255,255,255,0.9)" strokeWidth={lineWidth * 2.4} strokeLinecap="round" />
      <line x1={fx} y1={fy} x2={bodyX} y2={bodyY} stroke={item.color} strokeWidth={lineWidth} strokeLinecap="round" />
      <polygon points={points} fill={item.color} stroke="rgba(255,255,255,0.9)" strokeWidth={Math.max(1, lineWidth * 0.5)} />
    </g>
  )
}

/** 序号：圆徽章 + 数字（与选区编号徽章同规格，避免两套视觉） */
function IndexVisual({ item, w, h }: { item: MarkerAnnotation; w: number; h: number }) {
  const cx = item.from.x * w
  const cy = item.from.y * h
  const r = Math.max(11, indexBadgeRadius(item) * w)
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={item.color} stroke="rgba(255,255,255,1)" strokeWidth={Math.max(2, r * 0.16)} />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={Math.round(r * 1.15)}
        fontWeight={700}
        fill="#ffffff"
      >
        {item.index ?? 1}
      </text>
    </g>
  )
}

/** 文字标签：白描边打底 + 实色字，落在任意画面上都可读 */
function LabelVisual({ item, w, h }: { item: MarkerAnnotation; w: number; h: number }) {
  const fontSize = Math.max(12, item.width * w * 3)
  return (
    <text
      x={item.from.x * w}
      y={item.from.y * h}
      fontSize={fontSize}
      fontWeight={600}
      fill={item.color}
      stroke="rgba(255,255,255,0.92)"
      strokeWidth={Math.max(2, fontSize * 0.16)}
      paintOrder="stroke"
      dominantBaseline="text-after-edge"
    >
      {item.text ?? ''}
    </text>
  )
}

export default AnnotationLayer
