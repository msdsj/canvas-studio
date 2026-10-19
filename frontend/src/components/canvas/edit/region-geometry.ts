import type { NormRegion } from '../canvas-helpers'
import type { EditRegion } from '../edit-draft'

/**
 * 选区几何：移动 / 缩放 / 吸附。全部在归一化坐标（0-1，相对原图）里算，
 * 和缩放级别、屏幕尺寸无关；像素阈值由调用方按当前显示尺寸换算后传入。
 */

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

/** 吸附结果里的参考线（归一化坐标），用于画出「对齐到了哪里」 */
export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** 平移整个选区（含套索顶点 / 画笔笔迹），并保证整体不出图。 */
export function translateRegion(item: EditRegion, dx: number, dy: number): EditRegion {
  const { region } = item
  const ox = Math.min(Math.max(dx, -region.x), 1 - region.x - region.w)
  const oy = Math.min(Math.max(dy, -region.y), 1 - region.y - region.h)
  const shift = (point: { x: number; y: number }) => ({ ...point, x: point.x + ox, y: point.y + oy })
  return {
    ...item,
    region: { ...region, x: region.x + ox, y: region.y + oy, path: region.path?.map(shift) },
    path: item.path?.map(shift),
    strokes: item.strokes?.map((stroke) => ({ ...stroke, points: stroke.points.map(shift) })),
  }
}

/** 按把手缩放矩形选区；最小边长由 `min`（归一化）兜住，拖过头时不会翻转。 */
export function resizeRegion(
  item: EditRegion,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min: { w: number; h: number }
): EditRegion {
  const r = item.region
  let left = r.x
  let top = r.y
  let right = r.x + r.w
  let bottom = r.y + r.h
  if (handle.includes('w')) left = Math.min(clamp01(left + dx), right - min.w)
  if (handle.includes('e')) right = Math.max(clamp01(right + dx), left + min.w)
  if (handle.includes('n')) top = Math.min(clamp01(top + dy), bottom - min.h)
  if (handle.includes('s')) bottom = Math.max(clamp01(bottom + dy), top + min.h)
  return { ...item, region: { x: left, y: top, w: right - left, h: bottom - top } }
}

/**
 * 吸附：把选区的边/中线吸到图片边缘、图片中线、其它选区的边上。
 *
 * 只吸「正在动的那几条边」：缩放右下角时去吸左边没有意义，还会让框突然跳。
 * 返回修正后的区域 + 命中的参考线，调用方据此画辅助线。
 */
export function snapRegion(
  next: NormRegion,
  others: NormRegion[],
  threshold: { x: number; y: number },
  edges: { x: Array<'start' | 'mid' | 'end'>; y: Array<'start' | 'mid' | 'end'> },
  mode: 'move' | 'resize'
): { region: NormRegion; guides: SnapGuide[] } {
  const targetsX = [0, 0.5, 1]
  const targetsY = [0, 0.5, 1]
  for (const other of others) {
    targetsX.push(other.x, other.x + other.w)
    targetsY.push(other.y, other.y + other.h)
  }

  const guides: SnapGuide[] = []
  const region = { ...next }

  const pick = (
    values: Record<'start' | 'mid' | 'end', number>,
    keys: Array<'start' | 'mid' | 'end'>,
    targets: number[],
    tol: number
  ) => {
    let best: { key: 'start' | 'mid' | 'end'; delta: number; at: number } | null = null
    for (const key of keys) {
      for (const target of targets) {
        const delta = target - values[key]
        if (Math.abs(delta) <= tol && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { key, delta, at: target }
        }
      }
    }
    return best
  }

  const bx = pick(
    { start: region.x, mid: region.x + region.w / 2, end: region.x + region.w },
    edges.x,
    targetsX,
    threshold.x
  )
  if (bx) {
    if (mode === 'move') region.x += bx.delta
    else if (bx.key === 'start') {
      region.x += bx.delta
      region.w -= bx.delta
    } else region.w += bx.delta
    guides.push({ axis: 'x', at: bx.at })
  }

  const by = pick(
    { start: region.y, mid: region.y + region.h / 2, end: region.y + region.h },
    edges.y,
    targetsY,
    threshold.y
  )
  if (by) {
    if (mode === 'move') region.y += by.delta
    else if (by.key === 'start') {
      region.y += by.delta
      region.h -= by.delta
    } else region.h += by.delta
    guides.push({ axis: 'y', at: by.at })
  }

  return { region, guides }
}

/** 缩放把手会移动哪些边（吸附只对这些边生效） */
export function handleEdges(handle: ResizeHandle): {
  x: Array<'start' | 'end'>
  y: Array<'start' | 'end'>
} {
  return {
    x: handle.includes('w') ? ['start'] : handle.includes('e') ? ['end'] : [],
    y: handle.includes('n') ? ['start'] : handle.includes('s') ? ['end'] : [],
  }
}
