import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Eraser, PenLine, Redo2, RotateCcw, X } from 'lucide-react'

/** 一笔涂鸦（坐标均为原图坐标系，与分辨率解耦） */
interface DoodleStroke {
  points: Array<{ x: number; y: number }>
  color: string
  width: number
  mode: 'draw' | 'erase'
}

export interface DoodleResult {
  /** 原图分辨率合成图（原图 + 涂鸦） */
  file: File
  /** 涂鸦笔迹包围盒（归一化 0-1），作为编辑 region */
  region: { x: number; y: number; w: number; h: number }
}

interface CanvasDoodleProps {
  open: boolean
  /** 基准图（data URL 或 asset URL） */
  imageDataUrl: string
  imageWidth: number
  imageHeight: number
  /** 图片在画布容器内的显示矩形（画布内涂鸦时精确贴合原图位置，不缩放不位移） */
  imgRect?: { x: number; y: number; w: number; h: number } | null
  submitting?: boolean
  instruction: string
  onInstructionChange: (value: string) => void
  onCancel: () => void
  onSubmit: (result: DoodleResult) => void
  /** 编辑/提交失败反馈（如图片跨域无法导出） */
  onError?: (message: string) => void
}

const COLORS = ['#dc2626', '#f59e0b', '#2563eb', '#16a34a', '#ffffff']
const SIZES = [
  { label: '细', value: 4 },
  { label: '中', value: 8 },
  { label: '粗', value: 16 },
]
const ERASE_SCALE = 2.4

/** 图片涂鸦层：画笔/橡皮擦 + 撤销重做，原图分辨率合成后随指令提交上游。 */
export function CanvasDoodle({
  open,
  imageDataUrl,
  imageWidth,
  imageHeight,
  imgRect,
  instruction,
  onInstructionChange,
  onCancel,
  onSubmit,
  onError,
}: CanvasDoodleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const strokesRef = useRef<DoodleStroke[]>([])
  const redoRef = useRef<DoodleStroke[]>([])
  const drawingRef = useRef(false)
  const currentRef = useRef<DoodleStroke | null>(null)
  const rafRef = useRef(0)
  const [color, setColor] = useState(COLORS[0])
  const [size, setSize] = useState(SIZES[1].value)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [strokeCount, setStrokeCount] = useState(0)
  const [canRedo, setCanRedo] = useState(false)
  /** 画布实际使用的图片源：跨域 URL 会被转成同源 objectURL，避免 canvas 污染导致导出失败 */
  const [safeSrc, setSafeSrc] = useState('')

  // 跨域图片转 objectURL（同源 → canvas 不受污染）
  useEffect(() => {
    if (!open || !imageDataUrl) {
      setSafeSrc('')
      return
    }
    let objectUrl: string | null = null
    let cancelled = false
    const load = async () => {
      // data: URL 直接可用
      if (imageDataUrl.startsWith('data:')) {
        setSafeSrc(imageDataUrl)
        return
      }
      try {
        const resp = await fetch(imageDataUrl, { mode: 'cors' })
        if (!resp.ok) throw new Error('load failed')
        const blob = await resp.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSafeSrc(objectUrl)
      } catch {
        if (!cancelled) setSafeSrc(imageDataUrl)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [open, imageDataUrl])

  /** 重绘画布（已完成的笔 + 正在画的一笔） */
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    const scaleX = imageWidth / (canvas.width / dpr)
    const scaleY = imageHeight / (canvas.height / dpr)
    const paint = (stroke: DoodleStroke) => {
      if (stroke.points.length === 0) return
      ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.width * scaleX
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const pts = stroke.points
      ctx.moveTo(pts[0].x * scaleX, pts[0].y * scaleY)
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x * scaleX, pts[1].y * scaleY)
      } else {
        for (let i = 1; i < pts.length - 1; i += 1) {
          const cx = pts[i].x * scaleX
          const cy = pts[i].y * scaleY
          const nx = ((pts[i].x + pts[i + 1].x) / 2) * scaleX
          const ny = ((pts[i].y + pts[i + 1].y) / 2) * scaleY
          ctx.quadraticCurveTo(cx, cy, nx, ny)
        }
      }
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    strokesRef.current.forEach(paint)
    if (currentRef.current) paint(currentRef.current)
  }, [imageWidth, imageHeight])

  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current
    const holder = canvas?.parentElement
    if (!canvas || !holder) return
    const dpr = window.devicePixelRatio || 1
    const w = holder.clientWidth
    const h = holder.clientHeight
    if (w === 0 || h === 0) return
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    redraw()
  }, [redraw])

  useEffect(() => {
    if (!open) return
    strokesRef.current = []
    redoRef.current = []
    currentRef.current = null
    drawingRef.current = false
    setStrokeCount(0)
    setCanRedo(false)
    const timer = window.setTimeout(syncCanvasSize, 0)
    window.addEventListener('resize', syncCanvasSize)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', syncCanvasSize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [open, syncCanvasSize])

  /** 屏幕坐标 → 原图坐标 */
  const toImagePoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return {
      x: ((clientX - rect.left) / rect.width) * imageWidth,
      y: ((clientY - rect.top) / rect.height) * imageHeight,
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (submitting) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drawingRef.current = true
    const p = toImagePoint(e.clientX, e.clientY)
    currentRef.current = {
      points: [p],
      color,
      width: tool === 'eraser' ? size * ERASE_SCALE : size,
      mode: tool === 'eraser' ? 'erase' : 'draw',
    }
    redraw()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !currentRef.current) return
    currentRef.current.points.push(toImagePoint(e.clientX, e.clientY))
    // rAF 合并：每帧最多重绘一次，保证笔迹顺滑
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      redraw()
    })
  }

  const handlePointerUp = () => {
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

  const handleClear = () => {
    strokesRef.current = []
    redoRef.current = []
    currentRef.current = null
    setStrokeCount(0)
    setCanRedo(false)
    redraw()
  }

  const handleSubmit = async () => {
    const strokes = strokesRef.current
    const img = imgRef.current
    if (!strokes.length) {
      onError?.('请先在图上绘制标注')
      return
    }
    if (!img || !img.complete || !img.naturalWidth) {
      onError?.('图片尚未加载完成，请稍后重试')
      return
    }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = imageWidth
      canvas.height = imageHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // 底图
      ctx.drawImage(img, 0, 0, imageWidth, imageHeight)
      // 笔迹绘制在透明层（橡皮擦 = destination-out），再叠加到底图：擦除处自然露出底图
      const layer = document.createElement('canvas')
      layer.width = imageWidth
      layer.height = imageHeight
      const lctx = layer.getContext('2d')
      if (!lctx) return
      lctx.lineCap = 'round'
      lctx.lineJoin = 'round'
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const stroke of strokes) {
        if (stroke.points.length < 2) continue
        lctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'
        lctx.strokeStyle = stroke.color
        lctx.lineWidth = stroke.width
        lctx.beginPath()
        lctx.moveTo(stroke.points[0].x, stroke.points[0].y)
        for (let i = 1; i < stroke.points.length - 1; i += 1) {
          const cx = stroke.points[i].x
          const cy = stroke.points[i].y
          const nx = (stroke.points[i].x + stroke.points[i + 1].x) / 2
          const ny = (stroke.points[i].y + stroke.points[i + 1].y) / 2
          lctx.quadraticCurveTo(cx, cy, nx, ny)
        }
        const last = stroke.points[stroke.points.length - 1]
        lctx.lineTo(last.x, last.y)
        lctx.stroke()
        for (const pt of stroke.points) {
          if (pt.x < minX) minX = pt.x
          if (pt.y < minY) minY = pt.y
          if (pt.x > maxX) maxX = pt.x
          if (pt.y > maxY) maxY = pt.y
        }
      }
      lctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(layer, 0, 0)
      if (!isFinite(minX)) return
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) {
        onError?.('图像导出失败，请重试')
        return
      }
      const pad = Math.max(imageWidth, imageHeight) * 0.01
      const x = Math.max(0, minX - pad)
      const y = Math.max(0, minY - pad)
      const r = Math.min(imageWidth, Math.min(maxX + pad, imageWidth))
      const b = Math.min(imageHeight, Math.min(maxY + pad, imageHeight))
      onSubmit({
        file: new File([blob], 'doodle.png', { type: 'image/png' }),
        region: {
          x: x / imageWidth,
          y: y / imageHeight,
          w: Math.max(0.005, (r - x) / imageWidth),
          h: Math.max(0.005, (b - y) / imageHeight),
        },
      })
    } catch {
      // 最常见：跨域图片污染 canvas 导致导出被拒
      onError?.('该图片受跨域限制无法导出，请先「加入画布」后再编辑，或使用同一来源的图片')
    }
  }

if (!open) return null

  // 定位：给定 imgRect = 精确贴合画布上的图片（画布内涂鸦，不改变任何布局）；
  // 未给定（外部图片）= 在画布区域内居中显示
  const overlayStyle: React.CSSProperties = imgRect
    ? { position: 'absolute', left: imgRect.x, top: imgRect.y, width: imgRect.w, height: imgRect.h }
    : {
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        width: `min(100%, ${Math.min(imageWidth, 720)}px)`,
        aspectRatio: `${imageWidth} / ${imageHeight}`,
      }

  return (
    // 画布区内的透明叠加层：不改动页面布局、主题或任何既有参数
    <div className="absolute inset-0 z-30">
      {/* 图片 + 画笔层（贴合原图位置，不缩放不位移） */}
      <div className="pointer-events-auto" style={overlayStyle}>
        <img
          ref={imgRef}
          src={safeSrc}
          alt="编辑基准"
          className="absolute inset-0 h-full w-full select-none"
          draggable={false}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </div>

      {/* 浮动工具条（画布内顶部居中，轻量半透明，不遮挡整页） */}
      <div className="absolute left-1/2 top-3 z-10 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-full border border-border bg-surface/95 px-2.5 py-1.5 shadow-md backdrop-blur">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setTool('pen')}
            title="画笔"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
              tool === 'pen' ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <PenLine size={12} /> 画笔
          </button>
          <button
            type="button"
            onClick={() => setTool('eraser')}
            title="橡皮擦"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
              tool === 'eraser' ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <Eraser size={12} /> 橡皮
          </button>
        </div>
        <div className={`flex items-center gap-0.5 ${tool === 'eraser' ? 'opacity-40' : ''}`}>
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`颜色 ${c}`}
              onClick={() => {
                setColor(c)
                setTool('pen')
              }}
              className={`h-5 w-5 rounded-full border transition-transform ${
                color === c && tool === 'pen' ? 'scale-110 border-brand ring-2 ring-brand/40' : 'border-border'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="flex items-center gap-0.5">
          {SIZES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSize(s.value)}
              className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
                size === s.value ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:bg-surface-hover'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="whitespace-nowrap rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-text-secondary">
          {strokeCount} 笔 · {tool === 'eraser' ? `橡皮 ${Math.round(size * ERASE_SCALE)}px` : `${size}px`}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={!strokeCount}
            onClick={handleUndo}
            title="撤销"
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <RotateCcw size={12} />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={handleRedo}
            title="重做"
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Redo2 size={12} />
          </button>
          <button
            type="button"
            disabled={!strokeCount}
            onClick={handleClear}
            title="清空"
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Eraser size={12} />
          </button>
          <button
            type="button"
            onClick={onCancel}
            title="退出编辑"
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover"
          >
            <X size={12} />
          </button>
          <button
            type="button"
            disabled={!strokeCount || !instruction.trim()}
            onClick={() => void handleSubmit()}
            className="inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-[11px] font-medium text-text-inverse transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Check size={12} /> 提交
          </button>
        </div>
      </div>

      {/* 悬浮指令输入（画布底部居中，不占布局） */}
      <div className="absolute bottom-3 left-1/2 z-10 flex w-[min(520px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-1.5 shadow-md backdrop-blur">
        <input
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          placeholder="描述要修改的地方（如：把圈里的人物换成一位穿红裙的女性）"
          className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-text-tertiary focus:outline-none"
        />
        <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-text-tertiary">
          {imageWidth} × {imageHeight}
        </span>
      </div>
    </div>
  )
}