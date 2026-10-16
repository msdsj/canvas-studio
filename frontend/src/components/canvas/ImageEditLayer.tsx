import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Eraser, Frame, Hand, PenLine, Redo2, RotateCcw, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  buildEditPayload,
  type DoodleStroke,
  type NormRegion,
} from './canvas-helpers'

type Tool = 'region' | 'pen' | 'eraser'

interface EditRegion {
  id: string
  region: NormRegion
}

interface ImageEditLayerProps {
  open: boolean
  /** 编辑目标图（dataURL） */
  dataUrl: string
  naturalWidth: number
  naturalHeight: number
  /** 图片在画布容器内的显示矩形（精确贴合画布原图位置，不缩放不位移） */
  imgRect?: { x: number; y: number; w: number; h: number } | null
  submitting?: boolean
  /** 用户提示词（受控） */
  prompt: string
  onPromptChange: (value: string) => void
  /** 内置提示词前缀说明（来自后端配置，只读展示） */
  promptTemplate?: string
  /** 内置提示词预设 */
  presets?: Array<{ id: string; label: string; prompt: string }>
  onClose: () => void
  onSubmit: (payload: {
    baseFile: File
    maskFile: File | null
    regions: NormRegion[]
    prompt: string
  }) => void
  onDelete?: () => void
  onError?: (message: string) => void
}

const COLORS = ['#dc2626', '#f59e0b', '#2563eb', '#16a34a', '#ffffff']
const SIZES = [
  { label: '细', value: 0.004 },
  { label: '中', value: 0.009 },
  { label: '粗', value: 0.018 },
]
const ERASE_SCALE = 2.4
const MIN_BOX_PX = 10

/**
 * 统一的图片编辑层（类 Figma 就地编辑）：
 * - 框选：在图片上拖拽生成编号红框，可多个、可删除；
 * - 画笔 / 橡皮：直接在原图上涂鸦标注；
 * - 提示词：一次输入，随「带标记的图」一并提交上游执行图生图。
 * 编辑层精确贴合画布上的原图位置，不改变页面布局。
 */
export function ImageEditLayer({
  open,
  dataUrl,
  naturalWidth,
  naturalHeight,
  imgRect,
  submitting,
  prompt,
  onPromptChange,
  promptTemplate,
  presets = [],
  onClose,
  onSubmit,
  onDelete,
  onError,
}: ImageEditLayerProps) {
  const [tool, setTool] = useState<Tool>('region')
  const [color, setColor] = useState(COLORS[0])
  const [size, setSize] = useState(SIZES[1].value)
  const [regions, setRegions] = useState<EditRegion[]>([])
  const [draftRect, setDraftRect] = useState<NormRegion | null>(null)
  const [strokeCount, setStrokeCount] = useState(0)
  const [canRedo, setCanRedo] = useState(false)
  const [safeSrc, setSafeSrc] = useState('')
  const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const strokesRef = useRef<DoodleStroke[]>([])
  const redoRef = useRef<DoodleStroke[]>([])
  const currentRef = useRef<DoodleStroke | null>(null)
  const drawingRef = useRef(false)
  const regionStartRef = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef(0)

  // 跨域图片转 objectURL：避免 canvas 被污染导致导出（toBlob）失败
  useEffect(() => {
    if (!open || !dataUrl) {
      setSafeSrc('')
      return
    }
    if (dataUrl.startsWith('data:') || dataUrl.startsWith('blob:')) {
      setSafeSrc(dataUrl)
      return
    }
    let objectUrl: string | null = null
    let cancelled = false
    const load = async () => {
      try {
        const resp = await fetch(dataUrl, { mode: 'cors' })
        if (!resp.ok) throw new Error('load failed')
        const blob = await resp.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSafeSrc(objectUrl)
      } catch {
        if (!cancelled) setSafeSrc(dataUrl)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [open, dataUrl])

  // 每次打开重置编辑状态
  useEffect(() => {
    if (!open) return
    setRegions([])
    setDraftRect(null)
    setTool('region')
    strokesRef.current = []
    redoRef.current = []
    currentRef.current = null
    drawingRef.current = false
    regionStartRef.current = null
    setStrokeCount(0)
    setCanRedo(false)
  }, [open, dataUrl])

  /** 绘制涂鸦层（已完成笔迹 + 正在画的一笔）。 */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (w <= 0 || h <= 0) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const paint = (stroke: DoodleStroke) => {
      if (stroke.points.length < 2) return
      ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = Math.max(1, stroke.width * w)
      ctx.beginPath()
      const pts = stroke.points
      ctx.moveTo(pts[0].x * w, pts[0].y * h)
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x * w, pts[1].y * h)
      } else {
        for (let i = 1; i < pts.length - 1; i += 1) {
          const cx = pts[i].x * w
          const cy = pts[i].y * h
          const nx = ((pts[i].x + pts[i + 1].x) / 2) * w
          const ny = ((pts[i].y + pts[i + 1].y) / 2) * h
          ctx.quadraticCurveTo(cx, cy, nx, ny)
        }
      }
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    strokesRef.current.forEach(paint)
    if (currentRef.current) paint(currentRef.current)
  }, [])

  // 尺寸同步（含 imgRect 变化、窗口缩放、画布缩放）
  useEffect(() => {
    if (!open) return
    const el = wrapperRef.current
    if (!el) return
    const sync = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const w = el.clientWidth
      const h = el.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      setBoxSize({ w, h })
      redraw()
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [open, redraw, imgRect?.w, imgRect?.h, imgRect?.x, imgRect?.y])

  /** 屏幕坐标 → 归一化图片坐标 */
  const toNorm = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = wrapperRef.current
    if (!el) return { x: 0, y: 0 }
    const b = el.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (clientX - b.left) / Math.max(1, b.width))),
      y: Math.min(1, Math.max(0, (clientY - b.top) / Math.max(1, b.height))),
    }
  }

  const handleRegionDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (submitting) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toNorm(e.clientX, e.clientY)
    regionStartRef.current = p
    setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const handleRegionMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = regionStartRef.current
    if (!start) return
    const p = toNorm(e.clientX, e.clientY)
    setDraftRect({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    })
  }

  const handleRegionUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = regionStartRef.current
    regionStartRef.current = null
    setDraftRect(null)
    if (!start) return
    const p = toNorm(e.clientX, e.clientY)
    const el = wrapperRef.current
    const boxW = el?.clientWidth ?? 1
    const boxH = el?.clientHeight ?? 1
    const pxW = Math.abs(p.x - start.x) * boxW
    const pxH = Math.abs(p.y - start.y) * boxH
    if (pxW < MIN_BOX_PX || pxH < MIN_BOX_PX) return
    if (regions.length >= 8) {
      onError?.('最多支持 8 个框选区域，请先删除已有标记')
      return
    }
    setRegions((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        region: {
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x),
          h: Math.abs(p.y - start.y),
        },
      },
    ])
  }

  const handlePenDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (submitting) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drawingRef.current = true
    const p = toNorm(e.clientX, e.clientY)
    currentRef.current = {
      points: [p],
      color,
      width: tool === 'eraser' ? size * ERASE_SCALE : size,
      mode: tool === 'eraser' ? 'erase' : 'draw',
    }
    redraw()
  }

  const handlePenMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentRef.current) return
    currentRef.current.points.push(toNorm(e.clientX, e.clientY))
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      redraw()
    })
  }

  const handlePenUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
    const stroke = currentRef.current
    currentRef.current = null
    if (stroke && stroke.points.length > 1) {
      strokesRef.current.push(stroke)
      redoRef.current = []
      setStrokeCount(strokesRef.current.length)
      setCanRedo(false)
    }
    redraw()
  }

  const handleUndo = () => {
    const stroke = strokesRef.current.pop()
    if (!stroke) return
    redoRef.current.push(stroke)
    setStrokeCount(strokesRef.current.length)
    setCanRedo(true)
    redraw()
  }

  const handleRedo = () => {
    const stroke = redoRef.current.pop()
    if (!stroke) return
    strokesRef.current.push(stroke)
    setStrokeCount(strokesRef.current.length)
    setCanRedo(redoRef.current.length > 0)
    redraw()
  }

  const handleClearStrokes = () => {
    strokesRef.current = []
    redoRef.current = []
    currentRef.current = null
    setStrokeCount(0)
    setCanRedo(false)
    redraw()
  }

  const handleSubmit = async () => {
    const strokes = strokesRef.current
    if (regions.length === 0 && strokes.length === 0) {
      onError?.('请先在图片上框选区域或涂鸦标注')
      return
    }
    if (!prompt.trim()) {
      onError?.('请先输入修改提示词')
      return
    }
    try {
      const payload = await buildEditPayload({
        dataUrl,
        regions: regions.map((r) => r.region),
        strokes,
      })
      onSubmit({ ...payload, prompt: prompt.trim() })
    } catch {
      // 最常见：跨域图片污染 canvas 导致导出被拒
      onError?.('该图片受跨域限制无法导出，请先「加入画布」后再编辑')
    }
  }

  const handleDeleteRegion = (id: string) => {
    setRegions((prev) => prev.filter((item) => item.id !== id))
  }

  const canSubmit = !submitting && prompt.trim().length > 0 && (regions.length > 0 || strokeCount > 0)

  const overlayStyle: React.CSSProperties = useMemo(
    () =>
      imgRect
        ? { position: 'absolute', left: imgRect.x, top: imgRect.y, width: imgRect.w, height: imgRect.h }
        : {
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: `min(100%, ${Math.min(naturalWidth || 720, 720)}px)`,
            aspectRatio: `${naturalWidth || 1} / ${naturalHeight || 1}`,
          },
    [imgRect, naturalWidth, naturalHeight]
  )

  if (!open) return null

  const regionTool = tool === 'region'

  return (
    // 根节点不拦截指针：点击图片以外区域仍可落到画布（点空白处即退出编辑）
    <div className="pointer-events-none absolute inset-0 z-30">
      {/* 图片 + 涂鸦层 + 框选层（精确贴合画布原图，不改变布局） */}
      <div ref={wrapperRef} className="pointer-events-auto overflow-hidden" style={overlayStyle}>
        <img
          ref={imgRef}
          src={safeSrc}
          alt="编辑基准"
          className="absolute inset-0 h-full w-full select-none"
          draggable={false}
        />

        {/* 已框选区域：编号红框 + 删除按钮 */}
        {regions.map((item, index) => (
          <div
            key={item.id}
            className="pointer-events-none absolute z-20"
            style={{
              left: `${item.region.x * 100}%`,
              top: `${item.region.y * 100}%`,
              width: `${item.region.w * 100}%`,
              height: `${item.region.h * 100}%`,
              border: '2px solid rgba(220, 38, 38, 0.95)',
              background: 'rgba(255, 64, 64, 0.12)',
              boxShadow: '0 0 0 2px rgba(255,255,255,0.85)',
            }}
          >
            <span className="absolute -left-2.5 -top-2.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-[rgba(220,38,38,0.98)] text-[11px] font-bold text-white shadow">
              {index + 1}
            </span>
            <button
              type="button"
              title="删除该框选"
              className="pointer-events-auto absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full border border-white bg-black/70 text-white hover:bg-danger"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => handleDeleteRegion(item.id)}
            >
              <X size={11} />
            </button>
          </div>
        ))}

        {/* 正在拖拽的选框 */}
        {draftRect && draftRect.w > 0 && draftRect.h > 0 && (
          <div
            className="pointer-events-none absolute z-20"
            style={{
              left: `${draftRect.x * 100}%`,
              top: `${draftRect.y * 100}%`,
              width: `${draftRect.w * 100}%`,
              height: `${draftRect.h * 100}%`,
              border: '2px dashed rgba(255, 32, 32, 0.95)',
              background: 'rgba(255, 64, 64, 0.12)',
            }}
          />
        )}

        {/* 涂鸦层 */}
        <canvas
          ref={canvasRef}
          className={cn('absolute inset-0 z-0 touch-none', regionTool && 'pointer-events-none')}
          style={{ cursor: regionTool ? 'crosshair' : tool === 'eraser' ? 'cell' : 'crosshair' }}
          onPointerDown={handlePenDown}
          onPointerMove={handlePenMove}
          onPointerUp={handlePenUp}
          onPointerCancel={handlePenUp}
        />

        {/* 框选交互层（仅框选工具激活时接管指针；层级低于标记框，保证删除按钮可点） */}
        {regionTool && (
          <div
            className="absolute inset-0 z-10 touch-none"
            style={{ cursor: 'crosshair' }}
            onPointerDown={handleRegionDown}
            onPointerMove={handleRegionMove}
            onPointerUp={handleRegionUp}
          />
        )}
      </div>

      {/* 顶部工具条：下移避开 Excalidraw 原生工具条（避免两条工具栏重叠） */}
      <div className="pointer-events-auto absolute left-1/2 top-[88px] z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-full border border-border bg-surface/95 px-2.5 py-1.5 shadow-md backdrop-blur">
        <div className="flex items-center gap-0.5">
          <ToolButton active={regionTool} icon={<Frame size={12} />} label="框选" onClick={() => setTool('region')} />
          <ToolButton active={tool === 'pen'} icon={<PenLine size={12} />} label="画笔" onClick={() => setTool('pen')} />
          <ToolButton
            active={tool === 'eraser'}
            icon={<Eraser size={12} />}
            label="橡皮"
            onClick={() => setTool('eraser')}
          />
        </div>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <div className={cn('flex items-center gap-0.5', regionTool && 'opacity-40')}>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`颜色 ${c}`}
              onClick={() => {
                setColor(c)
                setTool('pen')
              }}
              className={cn(
                'h-5 w-5 rounded-full border transition-transform',
                color === c && !regionTool ? 'scale-110 border-brand ring-2 ring-brand/40' : 'border-border'
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className={cn('flex items-center gap-0.5', regionTool && 'opacity-40')}>
          {SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSize(s.value)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                size === s.value ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:bg-surface-hover'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <div className="flex items-center gap-0.5">
          <IconButton disabled={!strokeCount} title="撤销" onClick={handleUndo}>
            <RotateCcw size={12} />
          </IconButton>
          <IconButton disabled={!canRedo} title="重做" onClick={handleRedo}>
            <Redo2 size={12} />
          </IconButton>
          <IconButton disabled={!strokeCount} title="清空涂鸦" onClick={handleClearStrokes}>
            <Eraser size={12} />
          </IconButton>
        </div>
        <span className="whitespace-nowrap rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-text-secondary">
          {regions.length} 区域 · {strokeCount} 笔
        </span>
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            title="删除这张图片"
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-danger-subtle hover:text-danger"
          >
            <Trash2 size={12} /> 删除
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover"
        >
          <X size={12} /> 完成
        </button>
      </div>

      {/* 底部提示词输入 */}
      <div className="pointer-events-auto absolute bottom-3 left-1/2 z-20 w-[min(680px,calc(100%-24px))] -translate-x-1/2 rounded-xl border border-border bg-surface/95 p-2.5 shadow-lg backdrop-blur">
        {presets.length > 0 && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            {presets.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPromptChange(item.prompt)}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand hover:bg-brand-subtle hover:text-brand-text"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            placeholder="描述要如何修改框选区域（如：把框里的人物换成穿红裙的女性）"
            className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-text-tertiary focus:outline-none"
          />
          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-text-tertiary">
            {naturalWidth} × {naturalHeight}
          </span>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Check size={13} /> {submitting ? '提交中…' : '生成'}
          </button>
        </div>
        <p className="mt-1 truncate text-[10px] text-text-tertiary">
          <Hand size={10} className="mr-1 inline" />
          {promptTemplate || '请仅修改图中红色框选标记的区域，未标记区域保持完全不变。'}
        </p>
      </div>
    </div>
  )
}

function ToolButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors',
        active ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:text-text-secondary'
      )}
    >
      {icon} {label}
    </button>
  )
}

function IconButton({
  disabled,
  title,
  onClick,
  children,
}: {
  disabled?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:opacity-40"
    >
      {children}
    </button>
  )
}
