import { nanoid } from 'nanoid'
import type { CanvasElement, CanvasState } from '@/types/models'

/** Excalidraw API 的最小接口约束（避免耦合深层类型）。 */
export interface ExcalidrawApiLike {
  getSceneElements: () => CanvasElement[]
  getAppState: () => Record<string, unknown>
  getFiles: () => Record<string, unknown>
  updateScene: (scene: { elements?: CanvasElement[]; appState?: Record<string, unknown> }) => void
  addFiles: (files: Array<{ id: string; dataURL: string; mimeType: string; created: number }>) => void
  scrollToContent: (target?: unknown) => void
}

/** 归一化选区（相对原图 0-1）。 */
export interface NormRegion {
  x: number
  y: number
  w: number
  h: number
}

/** 一笔涂鸦：坐标与线宽均为归一化值（相对原图），与分辨率、缩放完全解耦。 */
export interface DoodleStroke {
  /** 归一化点序列（0-1，相对原图宽高） */
  points: Array<{ x: number; y: number }>
  color: string
  /** 归一化线宽（相对原图宽度） */
  width: number
  mode: 'draw' | 'erase'
}

/** 本地资源（/static/*）统一转为相对路径走同源代理，避免浏览器跨源 fetch 失败（Failed to fetch）。 */
function toSameOriginUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    if (parsed.pathname.startsWith('/static/')) {
      return `${parsed.pathname}${parsed.search}`
    }
    return url
  } catch {
    return url
  }
}

/** 把图片 URL 读取为 dataURL。 */
export async function urlToDataUrl(url: string): Promise<string> {
  const res = await fetch(toSameOriginUrl(url))
  const blob = await res.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 构造一个 Excalidraw 图片元素。 */
export function buildImageElement(params: {
  fileId: string
  x: number
  y: number
  width: number
  height: number
  assetId?: string
  name?: string
}): CanvasElement {
  const now = Date.now()
  return {
    id: nanoid(),
    type: 'image',
    x: params.x,
    y: params.y,
    width: params.width,
    height: params.height,
    angle: 0,
    strokeColor: 'transparent',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: Math.floor(Math.random() * 1_000_000),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000),
    isDeleted: false,
    boundElements: null,
    updated: now,
    link: null,
    locked: false,
    fileId: params.fileId,
    scale: [1, 1],
    status: 'saved',
    customData: {
      ...(params.assetId ? { assetId: params.assetId } : {}),
      ...(params.name ? { name: params.name } : {}),
    },
  }
}

/**
 * 计算「当前视口中心」对应的 scene 坐标。
 * 新图落在视口中心 = 用户一定能立刻看到（网格顺排会在图变多后落到可视区之外）。
 * scene = screen / zoom - scroll
 */
export function viewportCenterScene(
  api: ExcalidrawApiLike,
  elementWidth: number,
  elementHeight: number
): { x: number; y: number } {
  const appState = api.getAppState() as {
    zoom?: { value?: number }
    scrollX?: number
    scrollY?: number
    width?: number
    height?: number
  }
  const zoom = appState.zoom?.value ?? 1
  const scrollX = appState.scrollX ?? 0
  const scrollY = appState.scrollY ?? 0
  const vw = appState.width ?? 800
  const vh = appState.height ?? 600
  return {
    x: Math.round(vw / 2 / zoom - scrollX - elementWidth / 2),
    y: Math.round(vh / 2 / zoom - scrollY - elementHeight / 2),
  }
}

/** 往画布添加一张图片（可指定精确位置，用于"占位处渲染"），返回新建的元素以便滚动定位。 */
export async function addImageToCanvas(
  api: ExcalidrawApiLike,
  params: {
    url: string
    assetId?: string
    name?: string
    width?: number
    height?: number
    x?: number
    y?: number
  }
): Promise<CanvasElement> {
  const dataURL = await urlToDataUrl(params.url)
  const mimeType = dataURL.slice(5, dataURL.indexOf(';')) || 'image/png'
  const fileId = nanoid()
  api.addFiles([{ id: fileId, dataURL, mimeType, created: Date.now() }])

  const width = params.width && params.width > 0 ? params.width : 320
  const height = params.height && params.height > 0 ? params.height : 320
  const elements = api.getSceneElements()
  const pos =
    typeof params.x === 'number' && typeof params.y === 'number'
      ? { x: params.x, y: params.y }
      : viewportCenterScene(api, width, height)
  const element = buildImageElement({
    fileId,
    ...pos,
    width,
    height,
    assetId: params.assetId,
    name: params.name,
  })
  api.updateScene({ elements: [...elements, element] })
  return element
}

/** 空画布 scene。 */
export function emptyScene(): CanvasState {
  return { elements: [], appState: {}, files: {} }
}

/** 规范化后端返回的 state。 */
export function normalizeScene(state?: CanvasState | null): CanvasState {
  if (!state || typeof state !== 'object') return emptyScene()
  return {
    elements: Array.isArray(state.elements) ? state.elements : [],
    appState: state.appState ?? {},
    files: state.files ?? {},
  }
}

/** 读取画布元素对应的图片 dataURL（Excalidraw files 表）。 */
export function elementImageDataUrl(api: ExcalidrawApiLike | null, element: CanvasElement | null): string | null {
  if (!api || !element?.fileId) return null
  const files = api.getFiles() as Record<string, { dataURL?: string } | undefined>
  return files[String(element.fileId)]?.dataURL ?? null
}

/** 计算元素在画布容器中的显示矩形（scene → viewport），用于编辑层精确贴合。 */
export function elementScreenRect(
  api: ExcalidrawApiLike | null,
  element: CanvasElement | null
): { x: number; y: number; w: number; h: number } | null {
  if (!api || !element) return null
  try {
    const appState = api.getAppState() as {
      zoom?: { value?: number }
      scrollX?: number
      scrollY?: number
    }
    const zoom = appState.zoom?.value ?? 1
    const scrollX = appState.scrollX ?? 0
    const scrollY = appState.scrollY ?? 0
    const scale = (element as { scale?: [number, number] }).scale
    const sx = scale?.[0] ?? 1
    const sy = scale?.[1] ?? 1
    const x = element.x ?? 0
    const y = element.y ?? 0
    const w = element.width ?? 320
    const h = element.height ?? 320
    const angle = ((element as { angle?: number }).angle ?? 0) as number
    // 旋转元素用外接盒近似（编辑层不处理旋转图，避免坐标系复杂度）
    if (angle) {
      const rad = (angle * Math.PI) / 180
      const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))
      const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
      return {
        x: (x + (w - bw) / 2 + scrollX) * zoom,
        y: (y + (h - bh) / 2 + scrollY) * zoom,
        w: bw * zoom * sx,
        h: bh * zoom * sy,
      }
    }
    return {
      x: (x + scrollX) * zoom,
      y: (y + scrollY) * zoom,
      w: w * zoom * sx,
      h: h * zoom * sy,
    }
  } catch {
    return null
  }
}

/** 涂鸦笔迹的归一化包围盒（用于仅涂鸦、未框选时的编辑区域）。 */
export function strokesBBox(strokes: DoodleStroke[]): NormRegion | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false
  for (const stroke of strokes) {
    if (stroke.mode === 'erase') continue
    for (const p of stroke.points) {
      found = true
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!found) return null
  const pad = 0.012
  const x = Math.max(0, minX - pad)
  const y = Math.max(0, minY - pad)
  const r = Math.min(1, maxX + pad)
  const b = Math.min(1, maxY + pad)
  return { x, y, w: Math.max(0.01, r - x), h: Math.max(0.01, b - y) }
}

/** 把归一化涂鸦笔迹绘制到 2D 上下文（原生分辨率）。 */
function paintStrokes(ctx: CanvasRenderingContext2D, strokes: DoodleStroke[], w: number, h: number) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (stroke.points.length < 2) continue
    ctx.globalCompositeOperation = stroke.mode === 'erase' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = stroke.color
    ctx.lineWidth = Math.max(1, stroke.width * w)
    ctx.beginPath()
    const pts = stroke.points
    ctx.moveTo(pts[0].x * w, pts[0].y * h)
    for (let i = 1; i < pts.length - 1; i += 1) {
      const cx = pts[i].x * w
      const cy = pts[i].y * h
      const nx = ((pts[i].x + pts[i + 1].x) / 2) * w
      const ny = ((pts[i].y + pts[i + 1].y) / 2) * h
      ctx.quadraticCurveTo(cx, cy, nx, ny)
    }
    const last = pts[pts.length - 1]
    ctx.lineTo(last.x * w, last.y * h)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
}

/** 把归一化选区换算为像素矩形（夹取到图像内）。 */
function regionToPixels(region: NormRegion, w: number, h: number) {
  const x = Math.max(0, Math.min(w - 1, Math.round(region.x * w)))
  const y = Math.max(0, Math.min(h - 1, Math.round(region.y * h)))
  const rw = Math.max(1, Math.min(w - x, Math.round(region.w * w)))
  const rh = Math.max(1, Math.min(h - y, Math.round(region.h * h)))
  return { x, y, w: rw, h: rh }
}

/** 在给定 2D 上下文上绘制「白描边打底 + 红色实线 + 序号」的编号标记框。 */
function paintRegionMarks(ctx: CanvasRenderingContext2D, regions: NormRegion[], w: number, h: number) {
  const lineWidth = Math.max(3, Math.round(Math.min(w, h) / 220))
  regions.forEach((region, index) => {
    const { x: rx, y: ry, w: rw, h: rh } = regionToPixels(region, w, h)
    ctx.globalCompositeOperation = 'source-over'
    // 纯边框标记：白色外层描边打底 + 红色实色内层描边（浅色/深色/花色背景都清晰），内部不做任何填充
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.lineWidth = lineWidth * 2.8
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.strokeStyle = 'rgba(220, 38, 38, 1)'
    ctx.lineWidth = lineWidth
    ctx.strokeRect(rx, ry, rw, rh)

    // 序号：框内顶部居中（框过扁则骑在上边框线上），字号随框尺寸自适应
    const fontSize = Math.max(
      14,
      Math.min(Math.round(rh * 0.26), Math.round(rw * 0.14), Math.round(Math.min(w, h) / 40))
    )
    const label = String(index + 1)
    ctx.font = `bold ${fontSize}px sans-serif`
    const textW = ctx.measureText(label).width
    const boxW = Math.max(textW + fontSize * 0.62, fontSize * 1.45)
    const boxH = fontSize * 1.38
    const centerX = rx + rw / 2
    const gap = Math.max(2, Math.round(lineWidth * 0.8))
    const boxY = rh >= boxH * 2 ? ry + gap : ry - boxH / 2
    const boxX = Math.max(rx, Math.min(rx + Math.max(0, rw - boxW), centerX - boxW / 2))
    ctx.fillStyle = 'rgba(220, 38, 38, 1)'
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxW, boxH, Math.min(boxH / 2, 10))
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 1)'
    ctx.lineWidth = Math.max(2, Math.round(lineWidth * 0.7))
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, centerX, boxY + boxH / 2)
  })
}

export interface EditPayload {
  /** 底图（含涂鸦合成），PNG */
  baseFile: File
  /** 带编号红框的标记图（无框选时为 null），PNG */
  maskFile: File | null
  /** 归一化选区列表（无框选时回退为涂鸦包围盒） */
  regions: NormRegion[]
  /** 原图尺寸 */
  width: number
  height: number
}

/**
 * 生成图生图所需的「底图 + 标记图 + 选区」。
 * 平台统一 PNG：两张图都以 PNG 输出，与上游返回格式无关。
 */
export async function buildEditPayload(params: {
  dataUrl: string
  regions: NormRegion[]
  strokes: DoodleStroke[]
}): Promise<EditPayload> {
  const { dataUrl, regions, strokes } = params
  const resp = await fetch(dataUrl)
  const baseBlob = await resp.blob()
  const bitmap = await createImageBitmap(baseBlob)
  const w = bitmap.width
  const h = bitmap.height

  // 1) 底图 = 原图 + 涂鸦合成（橡皮 = destination-out，擦除处露出原图）
  const baseCanvas = document.createElement('canvas')
  baseCanvas.width = w
  baseCanvas.height = h
  const baseCtx = baseCanvas.getContext('2d')
  if (!baseCtx) throw new Error('canvas unsupported')
  baseCtx.drawImage(bitmap, 0, 0, w, h)
  if (strokes.length > 0) {
    const layer = document.createElement('canvas')
    layer.width = w
    layer.height = h
    const lctx = layer.getContext('2d')
    if (!lctx) throw new Error('canvas unsupported')
    paintStrokes(lctx, strokes, w, h)
    baseCtx.drawImage(layer, 0, 0)
  }
  const baseOut: Blob | null = await new Promise((resolve) => baseCanvas.toBlob(resolve, 'image/png'))
  if (!baseOut) throw new Error('base export failed')

  // 2) 标记图 = 底图 + 编号红框（仅框选时生成）
  const effectiveRegions = regions.length > 0 ? regions : []
  let maskFile: File | null = null
  if (effectiveRegions.length > 0) {
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = w
    maskCanvas.height = h
    const maskCtx = maskCanvas.getContext('2d')
    if (!maskCtx) throw new Error('canvas unsupported')
    maskCtx.drawImage(baseCanvas, 0, 0)
    paintRegionMarks(maskCtx, effectiveRegions, w, h)
    const maskOut: Blob | null = await new Promise((resolve) => maskCanvas.toBlob(resolve, 'image/png'))
    if (!maskOut) throw new Error('mask export failed')
    maskFile = new File([maskOut], 'region-mask.png', { type: 'image/png' })
  }

  const fallback = effectiveRegions.length === 0 ? strokesBBox(strokes) : null
  bitmap.close?.()
  return {
    baseFile: new File([baseOut], 'base.png', { type: 'image/png' }),
    maskFile,
    regions: effectiveRegions.length > 0 ? effectiveRegions : fallback ? [fallback] : [],
    width: w,
    height: h,
  }
}

/** 把图片 URL / dataURL 转成指定格式的 Blob（JPG 自动铺白底，PNG 保留透明）。 */
export async function imageToBlob(url: string, format: 'png' | 'jpg'): Promise<Blob> {
  const resp = await fetch(toSameOriginUrl(url))
  const blob = await resp.blob()
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  if (format === 'jpg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close?.()
  const out: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, format === 'jpg' ? 'image/jpeg' : 'image/png', format === 'jpg' ? 0.92 : undefined)
  )
  if (!out) throw new Error('export failed')
  return out
}

/** 触发浏览器下载。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 下载任意图片 URL 为指定格式。 */
export async function downloadImageAs(url: string, format: 'png' | 'jpg', baseName = 'image') {
  const blob = await imageToBlob(url, format)
  downloadBlob(blob, `${baseName}-${Date.now()}.${format}`)
}
