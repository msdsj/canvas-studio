import type { CanvasElement } from '@/types/models'

/**
 * 图片版本谱系。
 *
 * 画布上每一张「由另一张图改出来」的结果，都在 `customData` 里记下来源：
 * - `parentId`：来源图片的元素 id；
 * - `op`：改法（`region` 框选修改 / `enhance` 高清 / `cutout` 去背景 / `variation` 变体 …）。
 *
 * 只记元素 id、不记像素：谱系是画布内的关系，随场景一起落盘，
 * 撤销 / 删除来源图后自然断开（对比入口随之隐藏），不会出现悬空引用。
 */
export interface Lineage {
  parentId: string
  op: LineageOp
}

export type LineageOp = 'region' | 'enhance' | 'cutout' | 'variation'

/** 防御：谱系来自落盘数据，环或超长链都不该让界面卡死 */
const MAX_DEPTH = 32

function customOf(element: CanvasElement | null | undefined): Record<string, unknown> {
  return ((element?.customData ?? {}) as Record<string, unknown>) || {}
}

export function readLineage(element: CanvasElement | null | undefined): Lineage | null {
  const custom = customOf(element)
  const parentId = typeof custom.parentId === 'string' ? custom.parentId : ''
  if (!parentId) return null
  const op = typeof custom.op === 'string' ? (custom.op as LineageOp) : 'region'
  return { parentId, op }
}

/** 把谱系写进元素（返回新对象，不改原元素）。 */
export function withLineage(element: CanvasElement, lineage: Lineage): CanvasElement {
  return {
    ...element,
    customData: { ...customOf(element), parentId: lineage.parentId, op: lineage.op },
  }
}

/** 找到画布上仍然存在的来源图。 */
export function findParent(elements: readonly CanvasElement[], element: CanvasElement | null): CanvasElement | null {
  const lineage = readLineage(element)
  if (!lineage) return null
  return (
    elements.find(
      (item) => item.id === lineage.parentId && item.type === 'image' && !(item as { isDeleted?: boolean }).isDeleted
    ) ?? null
  )
}

/**
 * 版本号：沿 parentId 往上数（原图 = 1）。
 * 来源图被删掉时链条在那里断开——版本号只反映「画布上还看得到的历史」。
 */
export function versionOf(elements: readonly CanvasElement[], element: CanvasElement | null): number {
  let depth = 1
  let cursor = element
  const seen = new Set<string>()
  while (cursor && depth < MAX_DEPTH) {
    if (seen.has(cursor.id)) break
    seen.add(cursor.id)
    const parent = findParent(elements, cursor)
    if (!parent) break
    depth += 1
    cursor = parent
  }
  return depth
}
