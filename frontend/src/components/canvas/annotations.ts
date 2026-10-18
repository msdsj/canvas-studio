/**
 * 标注对象（R07 边框 / R08 标记）：**唯一来源**（见 ARCH-v2 §8.1-⑤）。
 *
 * 为什么是独立的判别式联合类型，而不是复用 `DoodleStroke` 或 `EditRegion`：
 *
 * 1. 复用 `DoodleStroke`（只有 points/color/width/mode）→ 边框「拖动位置」只能
 *    重算全部点。对虚线而言 `setLineDash` 的相位按路径长度累积，重算后视觉会跳。
 * 2. 复用 `EditRegion` → 会进 `regions` 数组，被 `paintUnionMask()` 当成「挖洞区」，
 *    于是「画一个边框」变成「把整块区域重绘」，违背主理人裁决 D3（边框/标记不产出选区）。
 * 3. 判别式联合让「渲染 / 命中测试 / 合成」三处各 switch 一次，新增工具 = 加一个 case。
 *
 * 坐标口径（ADR-5）：
 * - 全部**归一化 0–1**，相对原图宽高；**线宽也归一化**（相对原图宽度）。
 * - 不存像素坐标、不存 DPR、不存画布缩放——渲染时乘当前显示尺寸。
 * - 只存内存（挂在 `EditDraft` 上），不落 localStorage、不落 DB。
 */

import { nanoid } from 'nanoid'
import type { DoodleStroke, NormRegion } from './canvas-helpers'

/** 归一化坐标点（0-1，相对原图宽高）——与 `DoodleStroke.points` 完全一致 */
export interface Pt {
  x: number
  y: number
}

/** 归一化矩形（只含几何，不带选区语义上的 path） */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** 所有标注共有的字段：坐标归一化、线宽归一化，与分辨率/缩放解耦 */
interface AnnotationBase {
  id: string
  /** 归一化线宽（相对原图宽度），保证 1K 与 4K 图视觉一致 */
  width: number
  color: string
}

/** 涂鸦（既有能力，迁移为判别式成员）：字段顺序与 `DoodleStroke` 严格一致 */
export interface DoodleAnnotation extends AnnotationBase {
  kind: 'doodle'
  points: Pt[]
  mode: 'draw' | 'erase'
}

/** 边框（R07）：矩形 / 椭圆描边；拖拽时只平移 box 的 x/y */
export interface BorderAnnotation extends AnnotationBase {
  kind: 'border'
  shape: 'rect' | 'ellipse'
  /** 包围盒（归一化） */
  box: Box
  dash: 'solid' | 'dashed'
}

/** 标记（R08）：箭头 / 序号 / 文字标签 */
export interface MarkerAnnotation extends AnnotationBase {
  kind: 'marker'
  shape: 'arrow' | 'index' | 'label'
  /** 箭头：起点=尾，终点=头；index/label：from 为锚点，to 忽略 */
  from: Pt
  to: Pt
  /** shape==='label' 时必填，≤20 字符 */
  text?: string
  /** shape==='index' 时必填，1..99 */
  index?: number
}

export type AnnotationObject = DoodleAnnotation | BorderAnnotation | MarkerAnnotation

/** 命中容差（归一化）：2% 图宽 ≈ 1024 图上 20px，手指与鼠标都够得着 */
export const ANNOTATION_HIT_TOL = 0.02

/** 文字标签最大长度（R08） */
export const ANNOTATION_LABEL_MAX = 20

/** 序号上限（R08：1..99，超出不再自增，避免徽章撑爆画面） */
export const ANNOTATION_INDEX_MAX = 99

/** 生成一个标注 id（与选区 id 同源：nanoid，不引入第二套 id 方案） */
export function createAnnotationId(): string {
  return nanoid()
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 点是否落在矩形内（含边界） */
function insideBox(box: Box, pt: Pt): boolean {
  return pt.x >= box.x && pt.x <= box.x + box.w && pt.y >= box.y && pt.y <= box.y + box.h
}

/** 点到线段的最短距离（归一化空间；只用于命中测试，不做像素换算） */
function pointToSegment(pt: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 1e-9) return Math.hypot(pt.x - a.x, pt.y - a.y)
  let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lengthSq
  t = Math.min(1, Math.max(0, t))
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy))
}

/** 点到「矩形四条边」的最短距离（内部与外部都返回到最近边的距离） */
function distanceToRectEdge(box: Box, pt: Pt): number {
  const left = Math.abs(pt.x - box.x)
  const right = Math.abs(pt.x - (box.x + box.w))
  const top = Math.abs(pt.y - box.y)
  const bottom = Math.abs(pt.y - (box.y + box.h))
  const dx = Math.min(left, right)
  const dy = Math.min(top, bottom)
  if (insideBox(box, pt)) return Math.min(dx, dy)
  // 外部：角落处按欧氏距离，边上按单轴距离
  const outsideX = pt.x < box.x ? box.x - pt.x : pt.x > box.x + box.w ? pt.x - (box.x + box.w) : 0
  const outsideY = pt.y < box.y ? box.y - pt.y : pt.y > box.y + box.h ? pt.y - (box.y + box.h) : 0
  if (outsideX > 0 && outsideY > 0) return Math.hypot(outsideX, outsideY)
  return outsideX > 0 ? outsideX : outsideY
}

/** 点到椭圆轮廓的最短距离（近似：按归一化半径偏差换算到短轴尺度） */
function distanceToEllipseEdge(box: Box, pt: Pt): number {
  const rx = Math.max(1e-6, box.w / 2)
  const ry = Math.max(1e-6, box.h / 2)
  const cx = box.x + rx
  const cy = box.y + ry
  const nx = (pt.x - cx) / rx
  const ny = (pt.y - cy) / ry
  const radius = Math.hypot(nx, ny)
  // 以短轴为尺度把「归一化半径差」换算成距离：圆心处半径差 = 1 → 距离 ≈ 短轴
  return Math.abs(radius - 1) * Math.min(rx, ry)
}

/** 序号徽章的归一化半径（与选区编号徽章同规格：直径 ≈ 24px @1024 图宽） */
export function indexBadgeRadius(item: MarkerAnnotation): number {
  return Math.max(0.011, item.width * 1.6)
}

/**
 * 单个标注的归一化包围盒。
 *
 * 涂鸦按点集；边框按 box；标记按「箭头两端 / 徽章 / 文字估算宽度」。
 * 涂鸦的擦除笔迹不参与——它们不落墨，把它们算进来会把修改区域撑大。
 */
export function annotationBBox(item: AnnotationObject): Box | null {
  switch (item.kind) {
    case 'doodle': {
      if (item.mode === 'erase' || item.points.length === 0) return null
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const p of item.points) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
      const pad = item.width / 2
      return normalizeBox({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 })
    }
    case 'border': {
      const pad = item.width / 2
      return normalizeBox({
        x: item.box.x - pad,
        y: item.box.y - pad,
        w: item.box.w + pad * 2,
        h: item.box.h + pad * 2,
      })
    }
    case 'marker': {
      if (item.shape === 'arrow') {
        const x = Math.min(item.from.x, item.to.x)
        const y = Math.min(item.from.y, item.to.y)
        const w = Math.abs(item.to.x - item.from.x)
        const h = Math.abs(item.to.y - item.from.y)
        const pad = Math.max(item.width * 4, 0.012)
        return normalizeBox({ x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 })
      }
      if (item.shape === 'index') {
        const r = indexBadgeRadius(item)
        return normalizeBox({ x: item.from.x - r, y: item.from.y - r, w: r * 2, h: r * 2 })
      }
      // 文字标签：不测真实文本宽度（无 ctx 时测不准），按「字数 × 归一化字号」估算
      const fontSize = Math.max(0.012, item.width * 3)
      const text = item.text ?? ''
      const w = Math.max(fontSize * 2, text.length * fontSize * 0.62)
      const h = fontSize * 1.5
      return normalizeBox({ x: item.from.x, y: item.from.y - h, w, h })
    }
    default:
      return null
  }
}

/** 把可能越界的包围盒夹回 [0,1]，并保证最小尺寸 */
function normalizeBox(box: Box): Box {
  const x = clamp01(box.x)
  const y = clamp01(box.y)
  const right = clamp01(box.x + box.w)
  const bottom = clamp01(box.y + box.h)
  return {
    x,
    y,
    w: Math.max(0.005, right - x),
    h: Math.max(0.005, bottom - y),
  }
}

/**
 * 全部标注的并集包围盒（纯标注无选区时的兜底修改区域，R09 / PRD D3）。
 * 返回 null 表示没有任何「会落墨」的标注（例如只有擦除笔迹）。
 */
export function annotationsBBox(items: AnnotationObject[]): NormRegion | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false
  for (const item of items) {
    const box = annotationBBox(item)
    if (!box) continue
    found = true
    if (box.x < minX) minX = box.x
    if (box.y < minY) minY = box.y
    if (box.x + box.w > maxX) maxX = box.x + box.w
    if (box.y + box.h > maxY) maxY = box.y + box.h
  }
  if (!found) return null
  const x = clamp01(minX)
  const y = clamp01(minY)
  const right = clamp01(maxX)
  const bottom = clamp01(maxY)
  return { x, y, w: Math.max(0.01, right - x), h: Math.max(0.01, bottom - y) }
}

/**
 * 命中测试：从**最后画的**往前找（后画的在上层，视觉与命中一致）。
 *
 * 边框只判「轮廓附近」不判内部：内部留白必须能把点击透给绘制层，
 * 否则在已有边框里再画一个更小的边框会永远抓不到落笔点。
 */
export function hitTestAnnotation(
  items: AnnotationObject[],
  pt: Pt,
  tol: number = ANNOTATION_HIT_TOL
): AnnotationObject | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    switch (item.kind) {
      case 'doodle': {
        const reach = tol + item.width / 2
        if (item.points.length === 1) {
          if (Math.hypot(pt.x - item.points[0].x, pt.y - item.points[0].y) <= reach) return item
          break
        }
        for (let k = 1; k < item.points.length; k += 1) {
          if (pointToSegment(pt, item.points[k - 1], item.points[k]) <= reach) return item
        }
        break
      }
      case 'border': {
        const distance =
          item.shape === 'ellipse'
            ? distanceToEllipseEdge(item.box, pt)
            : distanceToRectEdge(item.box, pt)
        if (distance <= tol + item.width / 2) return item
        break
      }
      case 'marker': {
        if (item.shape === 'arrow') {
          if (pointToSegment(pt, item.from, item.to) <= tol + item.width) return item
          break
        }
        if (item.shape === 'index') {
          const r = indexBadgeRadius(item)
          if (Math.hypot(pt.x - item.from.x, pt.y - item.from.y) <= r + tol) return item
          break
        }
        const box = annotationBBox(item)
        if (box && insideBox(box, pt)) return item
        break
      }
      default:
        break
    }
  }
  return null
}

/**
 * 平移标注（**不改 id**）：边框只动 box.x/y，标记动 from/to，涂鸦平移点集。
 * 位移会被夹取，保证对象不会被拖出画面（拖丢了用户就再也找不回来）。
 */
export function translateAnnotation(item: AnnotationObject, dx: number, dy: number): AnnotationObject {
  const box = annotationBBox(item)
  let ddx = Number.isFinite(dx) ? dx : 0
  let ddy = Number.isFinite(dy) ? dy : 0
  if (box) {
    if (box.x + ddx < 0) ddx = -box.x
    if (box.y + ddy < 0) ddy = -box.y
    if (box.x + box.w + ddx > 1) ddx = 1 - (box.x + box.w)
    if (box.y + box.h + ddy > 1) ddy = 1 - (box.y + box.h)
  }
  switch (item.kind) {
    case 'doodle':
      return {
        ...item,
        points: item.points.map((p) => ({ x: p.x + ddx, y: p.y + ddy })),
      }
    case 'border':
      return {
        ...item,
        box: { ...item.box, x: item.box.x + ddx, y: item.box.y + ddy },
      }
    case 'marker':
      return {
        ...item,
        from: { x: item.from.x + ddx, y: item.from.y + ddy },
        to: { x: item.to.x + ddx, y: item.to.y + ddy },
      }
    default:
      return item
  }
}

/**
 * 下一个可用序号（R08 统一编号器）。
 *
 * 口径：从 `seq` 起算，且**永不小于「已有最大序号 + 1」**。
 * 删除不回收号码（回收会让用户刚看到的「第 3 处」突然变成「第 2 处」）。
 */
export function nextAnnotationIndex(seq: number, items: AnnotationObject[]): number {
  let maxUsed = 0
  for (const item of items) {
    if (item.kind !== 'marker' || item.shape !== 'index') continue
    const value = item.index ?? 0
    if (value > maxUsed) maxUsed = value
  }
  const next = Math.max(Math.floor(seq) || 1, maxUsed + 1, 1)
  return Math.min(next, ANNOTATION_INDEX_MAX)
}

/** `DoodleAnnotation` → `DoodleStroke`（结构兼容适配，供 `paintStrokePath` 复用） */
export function toDoodleStroke(annotation: DoodleAnnotation): DoodleStroke {
  return {
    points: annotation.points,
    color: annotation.color,
    width: annotation.width,
    mode: annotation.mode,
  }
}

/** `DoodleStroke` → `DoodleAnnotation`（反向适配：迁移/回放历史笔迹时用） */
export function toDoodleAnnotation(stroke: DoodleStroke, id?: string): DoodleAnnotation {
  return {
    id: id ?? createAnnotationId(),
    width: stroke.width,
    color: stroke.color,
    kind: 'doodle',
    points: stroke.points,
    mode: stroke.mode,
  }
}

/** 构造一个边框标注（默认值集中在数据层，UI 只传差异） */
export function createBorderAnnotation(params: {
  box: Box
  color: string
  width: number
  shape?: 'rect' | 'ellipse'
  dash?: 'solid' | 'dashed'
  id?: string
}): BorderAnnotation {
  return {
    id: params.id ?? createAnnotationId(),
    width: params.width,
    color: params.color,
    kind: 'border',
    shape: params.shape ?? 'rect',
    box: normalizeBox(params.box),
    dash: params.dash ?? 'solid',
  }
}

/** 构造一个标记标注 */
export function createMarkerAnnotation(params: {
  shape: 'arrow' | 'index' | 'label'
  from: Pt
  to?: Pt
  color: string
  width: number
  index?: number
  text?: string
  id?: string
}): MarkerAnnotation {
  const from = { x: clamp01(params.from.x), y: clamp01(params.from.y) }
  const to = params.to
    ? { x: clamp01(params.to.x), y: clamp01(params.to.y) }
    : { x: from.x, y: from.y }
  const text = params.text ? params.text.slice(0, ANNOTATION_LABEL_MAX) : undefined
  return {
    id: params.id ?? createAnnotationId(),
    width: params.width,
    color: params.color,
    kind: 'marker',
    shape: params.shape,
    from,
    to,
    ...(params.shape === 'label' && text ? { text } : {}),
    ...(params.shape === 'index'
      ? { index: Math.min(ANNOTATION_INDEX_MAX, Math.max(1, Math.floor(params.index ?? 1))) }
      : {}),
  }
}

/**
 * 标注计数（R09 的 `annotation_stats`）。
 *
 * `doodleExtra`：涂鸦目前仍存在 `EditDraft.strokes` 里（历史原因），
 * 由调用方把它加上，保证日志里的 doodle 数是**全部**涂鸦而不是标注数组里的那几个。
 */
export function annotationStats(
  items: AnnotationObject[],
  doodleExtra = 0
): { border: number; marker: number; doodle: number } {
  const stats = { border: 0, marker: 0, doodle: Math.max(0, Math.floor(doodleExtra)) }
  for (const item of items) {
    if (item.kind === 'border') stats.border += 1
    else if (item.kind === 'marker') stats.marker += 1
    else if (item.kind === 'doodle') stats.doodle += 1
  }
  return stats
}

/** 标注的简短人类描述（日志/提示文案用；不参与渲染） */
export function describeAnnotation(item: AnnotationObject): string {
  switch (item.kind) {
    case 'doodle':
      return item.mode === 'erase' ? '擦除' : '涂鸦'
    case 'border':
      return item.shape === 'ellipse' ? '椭圆边框' : '矩形边框'
    case 'marker':
      if (item.shape === 'arrow') return '箭头'
      if (item.shape === 'index') return `序号 ${item.index ?? 1}`
      return `文字「${item.text ?? ''}」`
    default:
      return '标注'
  }
}
