import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  centerOnScenePoint,
  sceneContentBox,
  viewportSceneBox,
  type ExcalidrawApiLike,
} from './canvas-helpers'

/** 缩略图尺寸（CSS 像素）。画布内容按需缩放到这个框里。 */
// Keep the navigator quiet in the corner so it supports orientation without
// competing with the artwork.  The larger canvas remains available for direct
// manipulation while this miniature map still has enough room to show the
// viewport rectangle.
export const MINIMAP_WIDTH = 96
export const MINIMAP_HEIGHT = 60
const MAP_W = MINIMAP_WIDTH
const MAP_H = MINIMAP_HEIGHT

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** scene 坐标系 → 缩略图坐标系的映射。 */
interface World extends Box {
  scale: number
  /** world 左上角在缩略图里的偏移（内容比例与框不同时用于居中） */
  ox: number
  oy: number
}

/**
 * 计算缩略图的显示范围：**内容 ∪ 取景框**，再留一圈边距。
 *
 * 只按内容算会出问题：视图 Zoom 到「整幅内容刚好铺满」时，取景框在 scene 坐标里
 * 比内容还大（多了画布比例带来的余量），取景框就会溢出缩略图、糊满整块；
 * 把取景框并进来，无论缩放到哪一档，框都完整落在缩略图内。
 */
function buildWorld(content: Box | null, view: Box | null): World | null {
  if (!content && !view) return null
  let box: Box
  if (content && view) {
    const right = Math.max(content.x + content.w, view.x + view.w)
    const bottom = Math.max(content.y + content.h, view.y + view.h)
    box = {
      x: Math.min(content.x, view.x),
      y: Math.min(content.y, view.y),
      w: right - Math.min(content.x, view.x),
      h: bottom - Math.min(content.y, view.y),
    }
  } else {
    box = { ...(content ?? view)! }
  }
  const pad = Math.max(24, Math.max(box.w, box.h) * 0.06)
  const world = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }
  const scale = Math.min(MAP_W / world.w, MAP_H / world.h)
  return {
    ...world,
    scale,
    ox: (MAP_W - world.w * scale) / 2,
    oy: (MAP_H - world.h * scale) / 2,
  }
}

interface CanvasMinimapProps {
  api: ExcalidrawApiLike | null
  className?: string
}

/**
 * 画布全局缩略图（嵌在右下角导航器里）。
 *
 * 解决什么问题：内容一多（尤其是程序落图把图排到视口之外）或用户把画布拖远了之后，
 * 主画布上只剩空白，「内容去哪了」没有答案。缩略图给出全局位置 + 当前取景框，
 * 点/拖缩略图即可把视口平移过去。
 *
 * 为什么用 canvas 而不是 SVG + React state：取景框要跟着主画布的平移/缩放每帧变化。
 * 走 state 意味着工作台在拖动时整棵重渲染（画布拖动必然掉帧），
 * 所以这里在 rAF 里直接画，并在「场景签名没变」时跳过重绘。
 *
 * 何时画：订阅 Excalidraw 的 onChange（平移 / 缩放 / 元素变化都会触发），
 * 有变化才排一帧。旧版是常驻 60fps 轮询：即便场景签名没变、最后只是 return，
 * 每帧也已经先取了一次全量元素、算了一次包围盒。API 不支持订阅时退回轮询。
 *
 * 注意（2026-10 实测）：这项改动省掉的是「每帧的取元素 + 算包围盒」这点浅成本，
 * 页面级空闲 CPU 上看不出差异（大头是 GSAP ticker / ScrollTrigger / Excalidraw
 * 本来就常驻的循环）。价值在于不再做无用功，不要拿它当性能优化的主要理由。
 *
 * 补充实测：**选中一张图时**，Excalidraw 的 onChange 会以 ~59 次/秒 触发，
 * 于是这里即便订阅了也会每帧重画一次（trace 里 draw 稳定 176 次/3s），
 * 与旧版轮询的实际绘制频率相同。真正的开销源头在 Excalidraw 对选中元素的重渲染，
 * 不在本组件。
 */
export function CanvasMinimap({ api, className }: CanvasMinimapProps) {
  const { t } = useTranslation('canvas')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** 上一次绘制使用的 world 映射（点击定位要把屏幕坐标反算回 scene 坐标）。 */
  const worldRef = useRef<World | null>(null)
  /**
   * 拖拽期间冻结的 world 映射。
   *
   * world 是「内容 ∪ 取景框」，拖拽本身会移动取景框、进而可能改变 world 与比例；
   * 若每帧重算，指针下的那个点在拖动过程中会不断被重新解释，表现为打滑。
   * 所以按下时冻结映射，抬手后再按新范围重算。
   */
  const frozenRef = useRef<World | null>(null)
  const draggingRef = useRef(false)
  /**
   * 缩略图里画真实的图片缩影，而不是灰块：一眼就能认出「那张海报在右上角」。
   * 解码好的位图按 fileId 缓存；新图解码完成时置脏，下一帧重画。
   */
  const thumbsRef = useRef(new Map<string, HTMLImageElement>())
  const dirtyRef = useRef(false)
  /** 请求下一帧重画一次（由 effect 注入；拖拽 / 位图解码完成时调用） */
  const requestDrawRef = useRef<() => void>(() => {})

  useEffect(() => {
    let raf = 0
    let lastSig = ''
    const canSubscribe = typeof api?.onChange === 'function'
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(draw)
    }
    const draw = () => {
      // 不支持订阅时保持旧的逐帧轮询；支持时只画这一帧
      raf = canSubscribe ? 0 : requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return
      const instance = api
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(MAP_W * dpr) || canvas.height !== Math.round(MAP_H * dpr)) {
        canvas.width = Math.round(MAP_W * dpr)
        canvas.height = Math.round(MAP_H * dpr)
        lastSig = ''
      }
      let elements: ReturnType<ExcalidrawApiLike['getSceneElements']> = []
      let view = null as Box | null
      if (instance) {
        try {
          elements = instance.getSceneElements()
        } catch {
          elements = []
        }
        view = viewportSceneBox(instance)
      }
      const content = sceneContentBox(elements)
      const frozen = draggingRef.current ? frozenRef.current : null
      const sig = [
        elements.length,
        content ? `${content.x.toFixed(1)},${content.y.toFixed(1)},${content.w.toFixed(1)},${content.h.toFixed(1)}` : '-',
        view ? `${view.x.toFixed(1)},${view.y.toFixed(1)},${view.w.toFixed(1)},${view.h.toFixed(1)}` : '-',
        frozen ? 'frozen' : 'free',
      ].join('|')
      if (sig === lastSig && !dirtyRef.current) return
      lastSig = sig
      dirtyRef.current = false
      let files: Record<string, { dataURL?: string } | undefined> = {}
      try {
        files = (instance?.getFiles() ?? {}) as typeof files
      } catch {
        files = {}
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, MAP_W, MAP_H)
      // 缩略图内容一律裁在框内：world 冻结后取景框可能探出边界
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, MAP_W, MAP_H)
      ctx.clip()

      const world = frozen ?? buildWorld(content, view)
      if (!world) {
        worldRef.current = null
        ctx.restore()
        return
      }
      worldRef.current = world
      if (!frozen) frozenRef.current = world
      const { scale, ox, oy } = world
      const toX = (x: number) => ox + (x - world.x) * scale
      const toY = (y: number) => oy + (y - world.y) * scale

      const styles = getComputedStyle(canvas)
      const ink = styles.getPropertyValue('--color-text-tertiary').trim() || '#7b7566'
      const mat = styles.getPropertyValue('--color-mat').trim() || '#ffffff'
      const accent = styles.getPropertyValue('--color-accent-strong').trim() || '#b9e63c'

      // 取景框底色先铺（在元素之下），保证内容块不会被色块压住看不清
      if (view) {
        ctx.fillStyle = accent
        ctx.globalAlpha = 0.14
        ctx.fillRect(toX(view.x), toY(view.y), view.w * scale, view.h * scale)
        ctx.globalAlpha = 1
      }

      // 元素块：图片实心、其他形状半透明（只求「看出东西在哪」，不还原细节）
      for (const el of elements) {
        if ((el as { isDeleted?: boolean }).isDeleted) continue
        const w = Math.abs(el.width ?? 0) * scale
        const h = Math.abs(el.height ?? 0) * scale
        if (w < 0.6 || h < 0.6) continue
        const x = toX(el.x ?? 0)
        const y = toY(el.y ?? 0)
        if (el.type === 'image') {
          ctx.fillStyle = mat
          ctx.fillRect(x, y, w, h)
          const fileId = el.fileId ? String(el.fileId) : ''
          const dataURL = fileId ? files[fileId]?.dataURL : undefined
          if (fileId && dataURL) {
            let thumb = thumbsRef.current.get(fileId)
            if (!thumb) {
              thumb = new Image()
              thumb.onload = () => {
                dirtyRef.current = true
                requestDrawRef.current()
              }
              thumb.src = dataURL
              thumbsRef.current.set(fileId, thumb)
            }
            if (thumb.complete && thumb.naturalWidth > 0 && w >= 2 && h >= 2) {
              try {
                ctx.drawImage(thumb, x, y, w, h)
              } catch {
                /* 解码失败时保留底色块 */
              }
            }
          }
          ctx.strokeStyle = ink
          ctx.lineWidth = 0.6
          ctx.strokeRect(x + 0.3, y + 0.3, Math.max(0.4, w - 0.6), Math.max(0.4, h - 0.6))
        } else {
          ctx.fillStyle = ink
          ctx.globalAlpha = 0.45
          ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h))
          ctx.globalAlpha = 1
        }
      }

      // 取景框描边画在最上层：一眼看出「当前看的是哪一块」
      if (view) {
        ctx.strokeStyle = accent
        ctx.lineWidth = 1.5
        const vx = toX(view.x)
        const vy = toY(view.y)
        const vw = view.w * scale
        const vh = view.h * scale
        // 圆角取景框：和外层卡片同一种语言，比直角硬框柔和
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') ctx.roundRect(vx, vy, vw, vh, 3)
        else ctx.rect(vx, vy, vw, vh)
        ctx.stroke()
      }
      ctx.restore()
    }
    requestDrawRef.current = schedule
    const unsubscribe = canSubscribe ? api!.onChange!(schedule) : undefined
    // 窗口缩放 / 换屏（DPR 变化）不一定触发画布 onChange
    window.addEventListener('resize', schedule, { passive: true })
    schedule()
    return () => {
      unsubscribe?.()
      window.removeEventListener('resize', schedule)
      requestDrawRef.current = () => {}
      if (raf) cancelAnimationFrame(raf)
    }
  }, [api])

  /** 把缩略图上的一个点映射回 scene 坐标并把视口移过去。 */
  const locate = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current
      const world = worldRef.current
      if (!canvas || !world) return
      const rect = canvas.getBoundingClientRect()
      const sceneX = world.x + (clientX - rect.left - world.ox) / world.scale
      const sceneY = world.y + (clientY - rect.top - world.oy) / world.scale
      centerOnScenePoint(api, sceneX, sceneY)
    },
    [api]
  )

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    draggingRef.current = true
    // 冻结当前映射，整个拖拽过程用同一套坐标换算（避免指针下打滑）
    frozenRef.current = worldRef.current
    event.currentTarget.setPointerCapture(event.pointerId)
    locate(event.clientX, event.clientY)
    requestDrawRef.current()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return
    locate(event.clientX, event.clientY)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    draggingRef.current = false
    frozenRef.current = null
    // 解冻后按新范围重算映射（签名里带 frozen/free，会触发一次重画）
    requestDrawRef.current()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      className={cn('rounded-[10px]', className)}
      title={t('minimap.hint', { defaultValue: '画布缩略图：点击或拖动可快速定位' })}
    >
      <canvas
        ref={canvasRef}
        width={MAP_W}
        height={MAP_H}
        style={{ width: MAP_W, height: MAP_H }}
        className="block cursor-crosshair touch-none rounded-[8px] bg-canvas"
        aria-label={t('minimap.hint', { defaultValue: '画布缩略图：点击或拖动可快速定位' })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    </div>
  )
}
