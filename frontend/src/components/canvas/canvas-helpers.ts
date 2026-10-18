import { nanoid } from 'nanoid'
import { getStroke } from 'perfect-freehand'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion, EASE } from '@/lib/motion'
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
  /** 自由选区（套索）多边形顶点；缺省表示矩形 */
  path?: Array<{ x: number; y: number }>
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

/**
 * 画笔自由选区：一个区域 = 包围盒 + 若干笔迹。
 *
 * 与矩形/套索选区在数据结构上**完全同构**（都是 ``NormRegion``），
 * 额外带上笔迹只是为了掩码能贴着笔画的真实形状走，而不是退化成矩形。
 */
export interface BrushRegionInput {
  /** 该区域内所有笔迹的合并包围盒（用于编号徽章、气泡定位与引导图红框） */
  region: NormRegion
  /** 该区域包含的画笔笔迹（归一化坐标，mode 恒为 draw） */
  strokes: DoodleStroke[]
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

/**
 * 读取图片的真实像素尺寸。
 * 一次任务可能产出多张（整图 + 独立素材，宽高比各不相同），
 * 落画布时需要按各自比例排布，否则会被强行拉成同一尺寸。
 */
export async function imageSize(url: string): Promise<{ width: number; height: number }> {
  try {
    const dataURL = await urlToDataUrl(url)
    return await new Promise((resolve) => {
      const img = new Image()
      img.onload = () =>
        resolve({ width: img.naturalWidth || 320, height: img.naturalHeight || 320 })
      img.onerror = () => resolve({ width: 320, height: 320 })
      img.src = dataURL
    })
  } catch {
    return { width: 320, height: 320 }
  }
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

/**
 * 遍历**全部**元素（含 Excalidraw 判定为已删除的 isDeleted）。
 *
 * `getSceneElements()` 会把 isDeleted 的元素过滤掉，但那是「暂存删除」：
 * 不清掉的话，撤销栈里一步 Undo 就会把删掉的图全部复活。
 */
export function allSceneElements(api: ExcalidrawApiLike): CanvasElement[] {
  const withDeleted = (api as { getSceneElementsIncludingDeleted?: () => CanvasElement[] })
    .getSceneElementsIncludingDeleted
  if (typeof withDeleted === 'function') {
    try {
      const list = withDeleted.call(api)
      if (Array.isArray(list)) return list
    } catch {
      /* 回落到可见元素 */
    }
  }
  return api.getSceneElements()
}

/**
 * 把「已落画布」但场景里其实没有的 url 重新补进来。
 *
 * 去重登记（localStorage 的 placedUrls）与场景是两套存储，可能失步：
 * 用户手动删了图、场景被清、或换设备打开。失步时如果只信登记表，
 * 结果是「提示已放入、画布上空无一物，而且再也放不进去」。
 * 所以登记表只用来挡**重复投放**，场景里没有的一律视为未落。
 */
/** 网页端「上传」的图片文件 id 前缀（Excalidraw 自己的文件表命名约定）。 */
const LOCAL_FILE_ID_PREFIX = ['f', ''].join(':')

/**
 * 把后端存的图片元素并进 Excalidraw 的文件表。
 *
 * 为什么需要：Excalidraw 的 `initialData.files` 只认「本会话上传的文件」命名
 * （`fileId` 形如 `f:xxx`）。我们库里存的是自己生成的 nanoid fileId，
 * 直接放进 files 会被过滤掉 → 图片元素永远补不上尺寸、场景里也就看不到内容。
 * 这里按「元素.fileId → files 里的 dataURL」重建一份符合命名的文件记录，
 * 并同步改写元素的 fileId 与 `fileId` 引用。
 */
export function adoptImageFiles(
  elements: CanvasElement[],
  files: Record<string, unknown>
): { elements: CanvasElement[]; files: Record<string, unknown> } {
  const outFiles: Record<string, unknown> = {}
  const mapping: Record<string, string> = {}
  for (const [key, value] of Object.entries(files ?? {})) {
    const file = value as { dataURL?: string; mimeType?: string; created?: number } | undefined
    if (!file?.dataURL) continue
    const nextId = key.startsWith(LOCAL_FILE_ID_PREFIX) ? key : `${LOCAL_FILE_ID_PREFIX}${key}`
    mapping[key] = nextId
    outFiles[nextId] = {
      ...file,
      id: nextId,
      mimeType: file.mimeType || 'image/png',
      created: file.created ?? Date.now(),
      lastRetrieved: Date.now(),
    }
  }
  if (Object.keys(mapping).length === 0) return { elements, files: {} }
  const nextElements = elements.map((el) => {
    const fid = el.fileId ? String(el.fileId) : ''
    if (!fid || !mapping[fid]) return el
    return { ...el, fileId: mapping[fid] } as CanvasElement
  })
  return { elements: nextElements, files: outFiles }
}

export function unplacedResultUrls(
  api: ExcalidrawApiLike | null,
  urls: string[],
  placed: string[]
): string[] {
  const placedSet = new Set(placed)
  let liveFiles: Set<string> | null = null
  if (api) {
    try {
      liveFiles = new Set(
        api
          .getSceneElements()
          .map((el) => (el.type === 'image' && el.fileId ? String(el.fileId) : ''))
          .filter(Boolean)
      )
    } catch {
      liveFiles = null
    }
  }
  return urls.filter((url) => {
    if (!placedSet.has(url)) return true
    if (!liveFiles) return false
    const match = url.match(/files\/([^/?#]+)\//)
    if (!match) return false
    return !liveFiles.has(match[1])
  })
}

/** 元素矩形（含旋转后的外接盒；scene 坐标）。 */
function elementBox(el: CanvasElement): { x: number; y: number; w: number; h: number } {
  const x = el.x ?? 0
  const y = el.y ?? 0
  const w = Math.abs(el.width ?? 0)
  const h = Math.abs(el.height ?? 0)
  const angle = Math.abs((el as { angle?: number }).angle ?? 0) % 180
  if (angle > 0.5) {
    const rad = (angle * Math.PI) / 180
    const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))
    const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
    return { x: x + (w - bw) / 2, y: y + (h - bh) / 2, w: bw, h: bh }
  }
  return { x, y, w, h }
}

interface ViewportMetrics {
  zoom: number
  scrollX: number
  scrollY: number
  width: number
  height: number
}

function viewportMetrics(api: ExcalidrawApiLike): ViewportMetrics {
  const appState = api.getAppState() as {
    zoom?: { value?: number }
    scrollX?: number
    scrollY?: number
    width?: number
    height?: number
  }
  return {
    zoom: appState.zoom?.value ?? 1,
    scrollX: appState.scrollX ?? 0,
    scrollY: appState.scrollY ?? 0,
    width: appState.width ?? 0,
    height: appState.height ?? 0,
  }
}
/**
 * 在视口内找一个**不与已有元素重叠**的落点（矩形碰撞检测 + 螺旋外扩）。
 *
 * 为什么不是「视口中心 + 固定偏移」：那个做法在有内容时一定会盖住已有图，
 * 用户看到的是「新图压在半张旧图上」。这里从视口中心起，按 64px 步长
 * 一圈圈向外找第一个空位；找不到就接受「基本不重叠」的次优解，
 * 最后才回到视口中心（至少保证新图可见）。
 */
export function findEmptySpot(
  api: ExcalidrawApiLike,
  width: number,
  height: number,
  gap = 24
): { x: number; y: number } {
  const v = viewportMetrics(api)
  let boxes: Array<{ x: number; y: number; w: number; h: number }> = []
  try {
    boxes = api
      .getSceneElements()
      .filter((el) => !(el as { isDeleted?: boolean }).isDeleted)
      .map(elementBox)
      .filter((box) => box.w > 0 && box.h > 0)
  } catch {
    boxes = []
  }

  const overlap = (x: number, y: number) =>
    boxes.reduce((sum, box) => {
      const ox = Math.min(x + width, box.x + box.w) - Math.max(x, box.x)
      const oy = Math.min(y + height, box.y + box.h) - Math.max(y, box.y)
      return ox > 0 && oy > 0 ? sum + ox * oy : sum
    }, 0)

  const area = Math.max(1, width * height)
  const viewW = v.width / v.zoom
  const viewH = v.height / v.zoom
  const cx = viewW / 2 - v.scrollX
  const cy = viewH / 2 - v.scrollY

  if (boxes.length === 0) {
    return { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2) }
  }

  // 1) 视口中心 → 向外螺旋：每圈 8 个候选点，步长随圈数放大
  const centerX = cx - width / 2
  const centerY = cy - height / 2
  if (overlap(centerX, centerY) === 0) {
    return { x: Math.round(centerX), y: Math.round(centerY) }
  }
  const step = Math.max(width, height) + gap
  for (let ring = 1; ring <= 12; ring += 1) {
    for (let k = 0; k < 8; k += 1) {
      const angle = (k / 8) * Math.PI * 2
      const x = centerX + Math.cos(angle) * step * ring * 0.75
      const y = centerY + Math.sin(angle) * step * ring * 0.75
      if (overlap(x, y) === 0) return { x: Math.round(x), y: Math.round(y) }
    }
  }

  // 2) 视口内网格扫描：螺旋出界后仍可能有空位（长条内容旁边）
  const cols = Math.max(1, Math.floor(viewW / (width + gap)))
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = -v.scrollX + gap + col * (width + gap)
      const y = -v.scrollY + gap + row * (height + gap)
      if (overlap(x, y) === 0) return { x: Math.round(x), y: Math.round(y) }
    }
  }

  // 3) 次优：视口内重叠面积最小的位置（保证新图一定在可视范围内）
  let best = { x: Math.round(centerX), y: Math.round(centerY) }
  let bestScore = Infinity
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < Math.max(1, cols); col += 1) {
      const x = -v.scrollX + gap + col * (width + gap)
      const y = -v.scrollY + gap + row * (height + gap)
      const score = overlap(x, y)
      if (score < bestScore) {
        bestScore = score
        best = { x: Math.round(x), y: Math.round(y) }
      }
    }
  }
  return bestScore < area ? best : { x: Math.round(centerX), y: Math.round(centerY) }
}

/**
 * 程序化落图的视口参数：让目标矩形（scene）落在视口中央附近。
 * 公式与 `viewportCenterScene` 互逆：scroll = 视口尺寸中心 / zoom − 目标中心。
 */
function focusViewportFor(
  v: ViewportMetrics,
  box: { x: number; y: number; w: number; h: number },
  zoom: number
) {
  return {
    zoom,
    scrollX: v.width / 2 / zoom - (box.x + box.w / 2),
    scrollY: v.height / 2 / zoom - (box.y + box.h / 2),
  }
}

/**
 * 平滑聚焦到某个 scene 矩形（GSAP 补间 appState 的 scrollX/scrollY/zoom）。
 *
 * 不用 `scrollToContent`：它是硬跳，落图后画面「啪」地一下换位置，
 * 用户会分不清是自己拖动了还是程序移动了。这里用 0.5s 的缓动把镜头推过去。
 *
 * 补间直接写 Excalidraw 的 appState，不经过 React state：
 * 每帧 setState 会让整个工作台重渲染，画布拖动必然掉帧。
 */
/**
 * 视口缩放（真正生效的写法）。
 *
 * 实测结论：本版本 Excalidraw 对 `updateScene({ appState: { zoom, scrollX, scrollY } })`
 * 只认 **scrollX/scrollY 的百分比字符串**（`'285.0%'`，与 JSX 里 style 的写法一致）；
 * 传数字会被忽略。zoom 则必须在同一个 apply 里用对象 `{ value }` 一起给出，
 * 两者都写对时缩放与定位都能落到位。
 */
function applyViewport(api: ExcalidrawApiLike, zoom: number, scrollX: number, scrollY: number) {
  api.updateScene({
    appState: {
      zoom: { value: zoom },
      scrollX: `${scrollX.toFixed(2)}%`,
      scrollY: `${scrollY.toFixed(2)}%`,
    },
  })
}

/**
 * 用滚轮事件驱动 Excalidraw 自己缩放（保留能力，当前未使用）。
 *
 * 为什么要绕这一圈：本版本 Excalidraw 不接受程序化写入的 zoom —— updateScene
 * 里的 zoom 会被它当成「用户正在缩放」而重算水平偏移，最终把内容推出画面
 * （实测：写入 zoom=0.55 后视口只剩左半张图）。唯一稳定可靠的方式是发一个
 * ctrl+wheel 给它，让它按自己的缩放逻辑居中。
 */
function wheelZoomBy(api: ExcalidrawApiLike, steps: number) {
  const el = document.querySelector('.cs-canvas-card .excalidraw')
  if (!el || steps === 0) return
  const rect = el.getBoundingClientRect()
  const clientX = rect.left + rect.width / 2
  const clientY = rect.top + rect.height / 2
  const deltaY = steps > 0 ? 80 : -80
  for (let i = 0; i < Math.abs(steps); i += 1) {
    el.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
      })
    )
  }
}

export function focusSceneBox(
  api: ExcalidrawApiLike | null,
  box: { x: number; y: number; w: number; h: number } | null,
  options: { padding?: number; minZoom?: number; maxZoom?: number; duration?: number } = {}
): void {
  if (!api || !box || box.w <= 0 || box.h <= 0) return
  const v = viewportMetrics(api)
  if (v.width <= 0 || v.height <= 0) return

  const padding = options.padding ?? 96
  const minZoom = options.minZoom ?? 0.15
  const maxZoom = options.maxZoom ?? 1
  const fit = Math.min(
    (v.width - padding * 2) / box.w,
    (v.height - padding * 2) / box.h
  )
  const zoom = Math.round(Math.min(maxZoom, Math.max(minZoom, fit)) * 100) / 100
  const target = focusViewportFor(v, box, zoom)

  if (shouldReduceMotion()) {
    api.updateScene({ appState: { zoom: { value: zoom }, scrollX: target.scrollX, scrollY: target.scrollY } })
    return
  }

  const proxy = { zoom: v.zoom, scrollX: v.scrollX, scrollY: v.scrollY }
  gsap.killTweensOf(proxy)
  gsap.to(proxy, {
    zoom,
    scrollX: target.scrollX,
    scrollY: target.scrollY,
    duration: options.duration ?? 0.52,
    ease: EASE.out,
    overwrite: true,
    onUpdate: () => {
      api.updateScene({
        appState: {
          zoom: { value: proxy.zoom },
          scrollX: proxy.scrollX,
          scrollY: proxy.scrollY,
        },
      })
    },
  })
}

/**
 * 首屏自适应缩放：加载场景后按内容包围盒算初始 zoom / scroll。
 *
 * 规则（固定，不随内容变化）：
 * - 空画布：zoom = 1，居中
 * - 有内容：按「内容适配视口 × 0.86」计算，居中
 * - 结果夹取在 [0.15, 1]：**绝不允许 > 1 的初始缩放**。
 *   在 1512 屏上默认 1.0 就等于「1 像素 = 1 像素」，一张 1024 的图会占掉
 *   大半屏，看起来就是「画布炸开、缩不动」。
 */
/** 场景内容的包围盒（scene 坐标；跳过已删除与空尺寸元素）。 */
export function sceneContentBox(
  elements: CanvasElement[]
): { x: number; y: number; w: number; h: number } | null {
  let box: { x: number; y: number; w: number; h: number } | null = null
  for (const el of elements) {
    if ((el as { isDeleted?: boolean }).isDeleted) continue
    const b = elementBox(el)
    if (b.w <= 0 || b.h <= 0) continue
    if (!box) {
      box = { ...b }
      continue
    }
    const right = Math.max(box.x + box.w, b.x + b.w)
    const bottom = Math.max(box.y + box.h, b.y + b.h)
    box.x = Math.min(box.x, b.x)
    box.y = Math.min(box.y, b.y)
    box.w = right - box.x
    box.h = bottom - box.y
  }
  return box
}

export function fitSceneToViewport(
  api: ExcalidrawApiLike | null,
  elements: CanvasElement[],
  options: { padding?: number; minZoom?: number; maxZoom?: number; ratio?: number } = {},
  overrideSize?: { width: number; height: number }
): void {
  if (!api) return
  const metrics = viewportMetrics(api)
  const v = {
    ...metrics,
    width: overrideSize?.width ?? metrics.width,
    height: overrideSize?.height ?? metrics.height,
  }
  if (v.width <= 0 || v.height <= 0) return

  const minZoom = options.minZoom ?? 0.15
  const maxZoom = options.maxZoom ?? 1
  const padding = options.padding ?? 72
  const ratio = options.ratio ?? 0.86

  const box = sceneContentBox(elements)
  if (!box) {
    // 空画布：只把 scene 原点摆到视口中心，不要碰 zoom
    // （写入 zoom 会让 Excalidraw 把「初始数据里的 1」当成用户操作去改写水平位置）
    api.updateScene({ appState: { scrollX: v.width / 2, scrollY: v.height / 2 } })
    return
  }
  const fit = Math.min((v.width - padding * 2) / box.w, (v.height - padding * 2) / box.h) * ratio
  const zoom = Math.round(Math.min(maxZoom, Math.max(minZoom, fit)) * 100) / 100
  /**
   * 1) 先把纵向对齐（纵向的 scroll 写入是可靠的）；
   * 2) 再用 ctrl+wheel 让 Excalidraw 自己缩放到目标值。
   */
  applyViewport(api, zoom, v.width / 2 / zoom - (box.x + box.w / 2), v.height / 2 / zoom - (box.y + box.h / 2))
  console.warn('[fitz]', JSON.stringify({ zoom, curr: viewportMetrics(api).zoom }))
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
  element: CanvasElement | null,
  _viewport?: { left: number; top: number } | null
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

/** 把 perfect-freehand 生成的轮廓点转成 Path2D。 */
function outlineToPath(outline: number[][]): Path2D {
  const path = new Path2D()
  if (outline.length === 0) return path
  path.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i += 1) {
    path.lineTo(outline[i][0], outline[i][1])
  }
  path.closePath()
  return path
}

/**
 * 计算一笔笔迹的像素轮廓（perfect-freehand）。
 *
 * 实时预览、导出标注图、导出选区掩码**共用**这一个几何来源，
 * 才能保证「用户在屏幕上看到的笔迹」＝「发给上游的形状」，不会出现
 * 预览一笔、掩码另一笔的情况。
 */
export function strokeOutlinePath(stroke: DoodleStroke, w: number, h: number): Path2D {
  if (stroke.points.length < 2 || w <= 0 || h <= 0) return new Path2D()
  const points = stroke.points.map((p) => [p.x * w, p.y * h] as [number, number])
  const size = Math.max(1, stroke.width * w)
  const outline = getStroke(points, {
    size,
    thinning: 0.55,
    smoothing: 0.55,
    streamline: 0.42,
    simulatePressure: true,
    last: true,
  })
  return outlineToPath(outline)
}

/**
 * 绘制单笔涂鸦（perfect-freehand 真迹算法）。
 *
 * 与「等宽 lineWidth + quadraticCurveTo」的区别：笔迹会随移动速度自然变粗细，
 * 起落笔有锥形收口，观感接近真实马克笔，而不是等宽的「塑料管」。
 * 编辑层实时预览与导出标注图共用这一个函数，保证所见即所得。
 */
export function paintStrokePath(
  ctx: CanvasRenderingContext2D,
  stroke: DoodleStroke,
  w: number,
  h: number
) {
  if (stroke.points.length < 2) return
  const path = strokeOutlinePath(stroke, w, h)
  const size = Math.max(1, stroke.width * w)

  // 橡皮擦模式：直接用透明色覆盖，避免 destination-out 在导出时失效
  if (stroke.mode === 'erase') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = 'rgba(0, 0, 0, 1)' // 完全不透明的黑色用于擦除
    ctx.fill(path)
    ctx.globalCompositeOperation = 'source-over'
    return
  }

  // 绘制模式：使用 perfect-freehand 生成平滑笔迹
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = stroke.color
  ctx.fill(path)

  // 【关键增强】为涂鸦添加高对比度描边，确保 AI 能清晰识别
  // 白色描边打底 + 彩色实色，在任何背景上都清晰可见
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = Math.max(2, size * 0.15) // 描边宽度为笔迹的 15%
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke(path)

  // 再绘制一次彩色实色，确保涂鸦主体清晰
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = Math.max(1, size * 0.08)
  ctx.stroke(path)
}

/** 画笔选区笔迹的显示色：半透明红色实心，无白描边（与标注涂鸦区分开）。 */
export const BRUSH_FILL = 'rgba(220, 38, 38, 0.20)'

/**
 * 绘制画笔选区的显示层（半透明红色实心）。
 *
 * 刻意**不加白色描边**：画笔画出来的是「选区」而不是「标注」，
 * 白描边会让它看起来像标注笔迹，用户无法区分两者。
 */
export function paintBrushStroke(
  ctx: CanvasRenderingContext2D,
  stroke: DoodleStroke,
  w: number,
  h: number
) {
  if (stroke.points.length < 2) return
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = BRUSH_FILL
  ctx.fill(strokeOutlinePath(stroke, w, h))
}

/**
 * 把「所有选区」画成一张并集掩码：**透明 = 可编辑，不透明 = 保留**。
 *
 * 口径与后端 ``_render_edit_mask`` 一致（OpenAI images/edits 的 inpainting 语义），
 * 因此前端生成的掩码可以直接顶替后端按包围盒自动生成的掩码——
 * 画笔 / 套索这些非矩形选区才不会退化成矩形。
 *
 * 调用方负责准备 canvas（尺寸 = 底图原图尺寸）与 transform。
 */
export function paintUnionMask(
  ctx: CanvasRenderingContext2D,
  params: {
    /** 矩形与套索选区（画笔区域的包围盒请放到 brushRegions，避免把整块矩形挖掉） */
    regions: NormRegion[]
    /** 画笔选区：按笔宽膨胀后的真实笔迹挖洞 */
    brushRegions: BrushRegionInput[]
    width: number
    height: number
  }
) {
  const { regions, brushRegions, width: w, height: h } = params
  if (w <= 0 || h <= 0) return
  ctx.save()
  // 1) 整张不透明 = 全部保留
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(0, 0, 0, 1)'
  ctx.fillRect(0, 0, w, h)

  // 2) 挖洞 = 交给上游重绘（destination-out 只减 alpha，不影响 RGB）
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = 'rgba(0, 0, 0, 1)'
  for (const region of regions) {
    if (region.path && region.path.length >= 3) {
      ctx.beginPath()
      region.path.forEach((point, index) => {
        const px = point.x * w
        const py = point.y * h
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.closePath()
      ctx.fill()
      continue
    }
    const { x, y, w: rw, h: rh } = regionToPixels(region, w, h)
    ctx.fillRect(x, y, rw, rh)
  }
  for (const item of brushRegions) {
    for (const stroke of item.strokes) {
      if (stroke.mode === 'erase') continue
      ctx.fill(strokeOutlinePath(stroke, w, h))
    }
  }
  ctx.restore()
}

/** 把归一化涂鸦笔迹绘制到 2D 上下文（原生分辨率）。 */
function paintStrokes(ctx: CanvasRenderingContext2D, strokes: DoodleStroke[], w: number, h: number) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    paintStrokePath(ctx, stroke, w, h)
  }
}

/** 把归一化选区换算为像素矩形（夹取到图像内）。 */
function regionToPixels(region: NormRegion, w: number, h: number) {
  const x = Math.max(0, Math.min(w - 1, Math.round(region.x * w)))
  const y = Math.max(0, Math.min(h - 1, Math.round(region.y * h)))
  const rw = Math.max(1, Math.min(w - x, Math.round(region.w * w)))
  const rh = Math.max(1, Math.min(h - y, Math.round(region.h * h)))
  return { x, y, w: rw, h: rh }
}

/** 一个标记框：区域几何 + 显示编号（编号与区域编号一致，不受标注数量影响）。 */
interface RegionMark {
  region: NormRegion
  label: number
}

/** 选区几何指纹（4 位小数）：用于把「画笔区域的包围盒」从矩形选区里剔出去。 */
function regionKey(region: NormRegion): string {
  const round = (value: number) => Math.round(value * 10000) / 10000
  return `${round(region.x)},${round(region.y)},${round(region.w)},${round(region.h)}`
}

/** 在给定 2D 上下文上绘制「白描边打底 + 红色实线 + 序号」的编号标记框。 */
function paintRegionMarks(ctx: CanvasRenderingContext2D, marks: RegionMark[], w: number, h: number) {
  const lineWidth = Math.max(4, Math.round(Math.min(w, h) / 180)) // 加粗线条

  /** 把矩形 / 自由多边形统一成一条待描边的路径。 */
  const buildPath = (region: NormRegion) => {
    ctx.beginPath()
    if (region.path && region.path.length >= 3) {
      region.path.forEach((point, index) => {
        const px = point.x * w
        const py = point.y * h
        if (index === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.closePath()
      return
    }
    const { x: rx, y: ry, w: rw, h: rh } = regionToPixels(region, w, h)
    ctx.rect(rx, ry, rw, rh)
  }

  marks.forEach(({ region, label: labelNumber }) => {
    const { x: rx, y: ry, w: rw, h: rh } = regionToPixels(region, w, h)
    ctx.globalCompositeOperation = 'source-over'

    // 【增强可见性】多层描边确保在任何背景上都清晰
    // 第一层：外层白色描边（更宽，确保对比度）
    ctx.strokeStyle = 'rgba(255, 255, 255, 1)'
    ctx.lineWidth = lineWidth * 4
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    buildPath(region)
    ctx.stroke()

    // 第二层：黑色阴影描边（增强立体感和对比度）
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)'
    ctx.lineWidth = lineWidth * 2.5
    buildPath(region)
    ctx.stroke()

    // 第三层：红色实线主体
    ctx.strokeStyle = 'rgba(220, 38, 38, 1)'
    ctx.lineWidth = lineWidth * 1.5
    buildPath(region)
    ctx.stroke()
    ctx.lineWidth = lineWidth * 2.8
    buildPath(region)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(220, 38, 38, 1)'
    ctx.lineWidth = lineWidth
    buildPath(region)
    ctx.stroke()

    // 序号：框内顶部居中（框过扁则骑在上边框线上），字号随框尺寸自适应
    const fontSize = Math.max(
      14,
      Math.min(Math.round(rh * 0.26), Math.round(rw * 0.14), Math.round(Math.min(w, h) / 40))
    )
    const label = String(labelNumber)
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
  /** 原始底图（不含涂鸦），用于服务端严格像素合成 */
  baseFile: File
  /** 兼容旧接口的标记图字段 */
  maskFile: File | null
  /** 带编号红框/涂鸦的指导图，仅供上游理解用户意图 */
  guideFile: File | null
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
  /**
   * 需要在标记图上画红框的区域下标（缺省 = 全部）。
   *
   * 本地处理类区域（抠图 / 就地挖空）**不应画框**：标记图是给上游的视觉指令，
   * 画了框就等于告诉上游「这里也要改」，会出现「要抠出来的地方反而被改了样式」。
   * 编号仍按区域原始序号，保证与指令中的「区域N」严格对应。
   */
  markIndexes?: number[]
  /**
   * 画笔自由选区（包围盒 + 笔迹）。
   *
   * 这些区域的包围盒通常也出现在 ``regions`` 里（编号、气泡、指令都要一致），
   * 生成掩码时会按几何指纹把它们从矩形选区中剔除，只留真实笔迹——
   * 否则「画了一笔」会变成「挖掉整块矩形」，上游会把整块区域重绘。
   */
  brushRegions?: BrushRegionInput[]
}): Promise<EditPayload> {
  const { dataUrl, regions, strokes } = params
  const resp = await fetch(dataUrl)
  const baseBlob = await resp.blob()
  const bitmap = await createImageBitmap(baseBlob)
  const w = bitmap.width
  const h = bitmap.height

  // 1) 底图 = 原图本身。涂鸦只能作为指导图上传，不能污染严格保真的底图。
  const baseCanvas = document.createElement('canvas')
  baseCanvas.width = w
  baseCanvas.height = h
  const baseCtx = baseCanvas.getContext('2d')
  if (!baseCtx) throw new Error('canvas unsupported')
  baseCtx.drawImage(bitmap, 0, 0, w, h)
  const baseOut: Blob | null = await new Promise((resolve) => baseCanvas.toBlob(resolve, 'image/png'))
  if (!baseOut) throw new Error('base export failed')

  const brushInputs = params.brushRegions ?? []
  const effectiveRegions = regions.length > 0 ? regions : []

  // 2) 指导图 = 原图 + 标注涂鸦 + 画笔笔迹 + 编号红框（只给上游看，不参与最终合成）
  const guideCanvas = document.createElement('canvas')
  guideCanvas.width = w
  guideCanvas.height = h
  const guideCtx = guideCanvas.getContext('2d')
  if (!guideCtx) throw new Error('canvas unsupported')
  guideCtx.drawImage(bitmap, 0, 0, w, h)
  if (strokes.length > 0) paintStrokes(guideCtx, strokes, w, h)
  // 画笔笔迹也画进引导图：屏幕上看到的选区长什么样，上游看到的就该是什么样
  for (const item of brushInputs) {
    for (const stroke of item.strokes) {
      if (stroke.mode === 'erase') continue
      paintBrushStroke(guideCtx, stroke, w, h)
    }
  }
  const requested = params.markIndexes
  const markIndexes =
    requested && requested.length > 0
      ? requested.filter((index) => index >= 0 && index < effectiveRegions.length)
      : effectiveRegions.map((_, index) => index)
  let guideFile: File | null = null
  if (markIndexes.length > 0) {
    paintRegionMarks(
      guideCtx,
      markIndexes.map((index) => ({ region: effectiveRegions[index], label: index + 1 })),
      w,
      h
    )
  }
  if (strokes.length > 0 || brushInputs.length > 0 || markIndexes.length > 0) {
    const guideOut: Blob | null = await new Promise((resolve) => guideCanvas.toBlob(resolve, 'image/png'))
    if (!guideOut) throw new Error('guide export failed')
    guideFile = new File([guideOut], 'edit-guide.png', { type: 'image/png' })
  }

  // 3) 并集掩码 = 矩形 + 套索 + 全部画笔笔迹的并集
  //    语义：透明(alpha=0)=允许修改，不透明(alpha=255)=保留（与后端 _render_edit_mask 一致）
  const brushKeys = new Set(brushInputs.map((item) => regionKey(item.region)))
  const maskRegions = effectiveRegions.filter((region) => !brushKeys.has(regionKey(region)))
  const hasSelection =
    maskRegions.length > 0 || brushInputs.some((item) => item.strokes.length > 0)
  let maskFile: File | null = null
  if (hasSelection) {
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = w
    maskCanvas.height = h
    const maskCtx = maskCanvas.getContext('2d')
    if (!maskCtx) throw new Error('canvas unsupported')
    paintUnionMask(maskCtx, {
      regions: maskRegions,
      brushRegions: brushInputs,
      width: w,
      height: h,
    })
    const maskOut: Blob | null = await new Promise((resolve) => maskCanvas.toBlob(resolve, 'image/png'))
    if (!maskOut) throw new Error('mask export failed')
    maskFile = new File([maskOut], 'edit-mask.png', { type: 'image/png' })
  }

  const fallback = effectiveRegions.length === 0 ? strokesBBox(strokes) : null
  bitmap.close?.()
  return {
    baseFile: new File([baseOut], 'base.png', { type: 'image/png' }),
    maskFile,
    guideFile,
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

export type ExportFormat = 'png' | 'jpg'

/**
 * 导出**当前选中的图片**（不是整块画布）。
 *
 * 多选时逐张下载，文件名带序号；返回实际导出张数（0 表示没选中图片）。
 * 只导出 image 类型元素——文字/箭头导出成图片没有意义，也容易让人误以为选错了。
 */
export async function downloadSelectedImages(
  api: ExcalidrawApiLike,
  format: ExportFormat
): Promise<number> {
  const appState = api.getAppState() as { selectedElementIds?: Record<string, boolean> }
  const selected = appState.selectedElementIds ?? {}
  const elements = api.getSceneElements().filter(
    (el) => el.type === 'image' && selected[el.id] && el.fileId
  )
  if (elements.length === 0) return 0

  const stamp = Date.now()
  let index = 0
  for (const element of elements) {
    const dataUrl = elementImageDataUrl(api, element)
    if (!dataUrl) continue
    const blob = await imageToBlob(dataUrl, format)
    index += 1
    const suffix = elements.length > 1 ? `-${index}` : ''
    downloadBlob(blob, `canvas-${stamp}${suffix}.${format}`)
  }
  return index
}
