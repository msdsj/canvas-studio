import { useCallback, useRef } from 'react'
import type { CanvasPatch } from '@/lib/api/collab'
import type { CanvasElement } from '@/types/models'

/** Excalidraw 元素的「版本」：优先 versionNonce，其次 version，都没有就是 0。 */
function elementVersion(element: CanvasElement): number {
  const nonce = element.versionNonce
  if (typeof nonce === 'number') return nonce
  const version = element.version
  if (typeof version === 'number') return version
  return 0
}

/**
 * 元素级 diff：把「上一版场景」和「这一版场景」的差异算成增量 patch。
 *
 * 为什么不用 Excalidraw 的原生 `onChange(elements, appState, files)` 增量：
 * 它给的是完整数组，没有「删了哪个」。但协作协议需要知道删除，
 * 否则同事删掉的图会在你这边一直留着（服务端也不会替我们推断）。
 *
 * 实现上维护一个 id → 元素 的快照表，每次比对新旧两张表：
 * 新 id = 新增、版本变了 = 更新、消失的 id = 删除。复杂度 O(n)，
 * 画布上有几百个元素时也只是几次 Map 遍历，远快于一帧 16ms 的预算。
 */
export function useSceneDiff() {
  /** 上一次已知的元素表（含版本号） */
  const snapshotRef = useRef<Map<string, CanvasElement>>(new Map())
  /** 远端 patch 应用期间不要把自己的回放当成新改动再发出去（会形成回环） */
  const suppressRef = useRef(false)

  /** 用一份完整场景重置基线（初次加载 / 全量重同步后调用）。 */
  const reset = useCallback((elements: CanvasElement[]) => {
    const map = new Map<string, CanvasElement>()
    for (const element of elements) {
      if (element?.id) map.set(element.id, element)
    }
    snapshotRef.current = map
  }, [])

  /** 计算增量。返回 null 表示没有实质变化（只是平移/选中）。 */
  const diff = useCallback((elements: CanvasElement[]): CanvasPatch | null => {
    if (suppressRef.current) return null
    const previous = snapshotRef.current
    const next = new Map<string, CanvasElement>()
    const added: CanvasElement[] = []
    const updated: CanvasElement[] = []

    for (const element of elements) {
      if (!element?.id) continue
      next.set(element.id, element)
      const before = previous.get(element.id)
      if (!before) {
        added.push(element)
        continue
      }
      // 版本号变了才算改过：拖动时 Excalidraw 会持续 bump versionNonce
      if (elementVersion(element) !== elementVersion(before)) {
        updated.push(element)
      }
    }

    const deleted: string[] = []
    for (const id of previous.keys()) {
      if (!next.has(id)) deleted.push(id)
    }

    snapshotRef.current = next
    if (added.length === 0 && updated.length === 0 && deleted.length === 0) return null
    return {
      // 只传必要字段会更快，但 Excalidraw 的元素是整体替换的语义，
      // 少传一个字段就等于把它清空——所以原样传完整元素
      added: added as unknown as Array<Record<string, unknown>>,
      updated: updated as unknown as Array<Record<string, unknown>>,
      deleted,
    }
  }, [])

  /** 把远端 patch 应用到本地快照基线（避免下次 diff 又把它当成本地改动发回去）。 */
  const absorb = useCallback((patch: CanvasPatch) => {
    const map = snapshotRef.current
    for (const element of patch.added ?? []) {
      const id = String((element as { id?: string }).id ?? '')
      if (id) map.set(id, element as unknown as CanvasElement)
    }
    for (const element of patch.updated ?? []) {
      const id = String((element as { id?: string }).id ?? '')
      if (id) map.set(id, element as unknown as CanvasElement)
    }
    for (const id of patch.deleted ?? []) {
      map.delete(id)
    }
  }, [])

  /** 在应用远端 patch 期间抑制本地 diff（包裹一次 updateScene 调用）。 */
  const withSuppressed = useCallback((fn: () => void) => {
    suppressRef.current = true
    try {
      fn()
    } finally {
      // Excalidraw 的 onChange 是同步派发的；给一个微任务兜底更稳
      queueMicrotask(() => {
        suppressRef.current = false
      })
    }
  }, [])

  return { reset, diff, absorb, withSuppressed }
}
