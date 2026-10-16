import { nanoid } from 'nanoid'
import type { CanvasElement, CanvasState, RegionSelection } from '@/types/models'

/** Excalidraw API 的最小接口约束（避免耦合深层类型）。 */
export interface ExcalidrawApiLike {
  getSceneElements: () => CanvasElement[]
  getAppState: () => Record<string, unknown>
  getFiles: () => Record<string, unknown>
  updateScene: (scene: { elements: CanvasElement[] }) => void
  addFiles: (files: Array<{ id: string; dataURL: string; mimeType: string; created: number }>) => void
  scrollToContent: (target?: unknown) => void
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

/** 计算下一个图片落点（简单网格排布）。 */
export function nextPosition(elements: CanvasElement[]): { x: number; y: number } {
  const images = elements.filter((el) => el.type === 'image')
  if (images.length === 0) return { x: 80, y: 80 }
  const last = images[images.length - 1]
  const x = (last.x ?? 80) + (last.width ?? 240) + 40
  if (x > 1200) {
    return { x: 80, y: (last.y ?? 80) + (last.height ?? 240) + 40 }
  }
  return { x, y: last.y ?? 80 }
}

/** 构造一个 Excalidraw 图片元素。 */
export function buildImageElement(params: {
  fileId: string
  x: number
  y: number
  width: number
  height: number
  assetId?: string
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
    customData: params.assetId ? { assetId: params.assetId } : {},
  }
}

/** 往画布添加一张图片（可指定精确位置，用于"占位处渲染"）。 */
export async function addImageToCanvas(
  api: ExcalidrawApiLike,
  params: { url: string; assetId?: string; width?: number; height?: number; x?: number; y?: number }
): Promise<void> {
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
      : nextPosition(elements)
  const element = buildImageElement({ fileId, ...pos, width, height, assetId: params.assetId })
  api.updateScene({ elements: [...elements, element] })
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

/** 生成缩略图 dataURL（基于画布可见内容，简化：取第一张图片）。 */
export function guessThumbnail(state: CanvasState): string | undefined {
  const image = state.elements.find((el) => el.type === 'image')
  return typeof image?.url === 'string' ? image.url : undefined
}

/** 由底图 dataURL 与归一化选区生成编辑所需的「底图文件 + 高亮标记图」。 */
export async function buildRegionSelection(
  dataUrl: string,
  region: { x: number; y: number; w: number; h: number }
): Promise<RegionSelection> {
  const multi = await buildMultiRegionSelection(dataUrl, [region])
  return {
    baseFile: multi.baseFile,
    baseUrl: multi.baseUrl,
    maskFile: multi.maskFile,
    region,
  }
}

export interface MultiRegionSelection {
  baseFile: File
  baseUrl: string
  maskFile: File
  regions: Array<{ x: number; y: number; w: number; h: number }>
}

/** 由底图 dataUrl 与多个归一化选区生成「底图文件 + 带编号红框的完整标记图」（编号与分点提示词一一对应）。 */
export async function buildMultiRegionSelection(
  dataUrl: string,
  regions: Array<{ x: number; y: number; w: number; h: number }>
): Promise<MultiRegionSelection> {
  const resp = await fetch(dataUrl)
  const baseBlob = await resp.blob()
  const bitmap = await createImageBitmap(baseBlob)
  const cw = bitmap.width
  const ch = bitmap.height
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unsupported')
  ctx.drawImage(bitmap, 0, 0, cw, ch)
  const lineWidth = Math.max(3, Math.round(Math.min(cw, ch) / 220))
  regions.forEach((region, index) => {
    const rx = Math.round(region.x * cw)
    const ry = Math.round(region.y * ch)
    const rw = Math.max(1, Math.round(region.w * cw))
    const rh = Math.max(1, Math.round(region.h * ch))
    // 纯边框标记：白色外层描边打底 + 红色实色内层描边（浅色/深色/花色背景都清晰），内部不做任何填充
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.lineWidth = lineWidth * 2.8
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.strokeStyle = 'rgba(220, 38, 38, 1)'
    ctx.lineWidth = lineWidth
    ctx.strokeRect(rx, ry, rw, rh)

    // 序号：水平居中于框的正上方（框外，绝不遮挡），字号随框尺寸自适应（小框配小标、大框才放大）
    const fontSize = Math.max(
      14,
      Math.min(
        Math.round(rh * 0.26),
        Math.round(rw * 0.14),
        Math.round(Math.min(cw, ch) / 40)
      )
    )
    const label = String(index + 1)
    ctx.font = `bold ${fontSize}px sans-serif`
    const textW = ctx.measureText(label).width
    const boxW = Math.max(textW + fontSize * 0.62, fontSize * 1.45)
    const boxH = fontSize * 1.38
    const centerX = rx + rw / 2
    // 序号置于矩形框内部：水平居中、顶部对齐（不遮挡框内核心内容）；
    // 若框过扁装不下，则骑在上边框线上，保证始终可读
    const gap = Math.max(2, Math.round(lineWidth * 0.8))
    // 空间充足 → 框内顶部居中；框过扁（装不下标牌）→ 骑在上边框线上，避免遮挡被标记内容
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
  bitmap.close?.()
  const maskBlob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!maskBlob) throw new Error('mask export failed')
  return {
    baseFile: new File([baseBlob], 'base.png', { type: baseBlob.type || 'image/png' }),
    baseUrl: dataUrl,
    maskFile: new File([maskBlob], 'region-mask.png', { type: 'image/png' }),
    regions,
  }
}
