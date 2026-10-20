import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCanvasCollab, type CollabStatus } from '@/hooks/use-canvas-collab'
import type { CollabParticipant } from '@/lib/api/collab'
import { useSceneDiff } from './useSceneDiff'
import type { CanvasElement, CanvasState } from '@/types/models'
import type { ExcalidrawApiLike } from './canvas-helpers'

interface UseCanvasCollabSceneOptions {
  canvasId: string | null
  /** 是否启用协作（团队画布 / 显式协作者才连） */
  enabled: boolean
  /** 画布尚未加载完时不要连：连上去拿到的快照会把本地状态冲掉 */
  ready: boolean
  /** Excalidraw API（用于把远端改动 apply 回本地） */
  api: ExcalidrawApiLike | null
  /** 整场景自动保存的 flush：切到协作模式后仍需在离开时兜底落盘 */
  onRemoteFullSync: () => void
}

/**
 * 协作模式的场景桥接。
 *
 * 三个职责，缺一不可：
 * 1. **本地上行**：onChange → diff → 发 patch（只在连上时才发，否则返回 false，
 *    由调用方回退到整场景自动保存）；
 * 2. **远端下行**：收到 patch → updateScene（增量合并到 Excalidraw 内部状态，
 *    不能整份替换，否则会打断用户正在拖拽的那只手）；
 * 3. **回环抑制**：updateScene 会触发 onChange，如果不抑制，自己的改动会被
 *    当成新的本地改动再发一遍，两个客户端互相放大，几秒内就能把房间刷爆。
 */
export function useCanvasCollabScene({
  canvasId,
  enabled,
  ready,
  api,
  onRemoteFullSync,
}: UseCanvasCollabSceneOptions) {
  const { reset, diff, absorb, withSuppressed } = useSceneDiff()
  const apiRef = useRef<ExcalidrawApiLike | null>(api)
  apiRef.current = api
  const onRemoteFullSyncRef = useRef(onRemoteFullSync)
  onRemoteFullSyncRef.current = onRemoteFullSync
  /** 已就绪且已建立基线的画布 id：切换画布时要重新 reset */
  const baselineRef = useRef<string | null>(null)
  const [participants, setParticipants] = useState<CollabParticipant[]>([])

  const handlePatch = useCallback(
    (patch: Parameters<typeof absorb>[0]) => {
      const instance = apiRef.current
      if (!instance) return
      const current = (instance.getSceneElements?.() ?? []) as CanvasElement[]
      const byId = new Map(current.map((element) => [element.id, element]))
      for (const element of patch.added ?? []) {
        const id = String((element as { id?: string }).id ?? '')
        if (id) byId.set(id, element as unknown as CanvasElement)
      }
      for (const element of patch.updated ?? []) {
        const id = String((element as { id?: string }).id ?? '')
        if (id) byId.set(id, element as unknown as CanvasElement)
      }
      for (const id of patch.deleted ?? []) {
        byId.delete(id)
      }
      // absorb 先更新 diff 基线，避免 updateScene 触发的 onChange 被当成本地改动
      absorb(patch)
      withSuppressed(() => {
        instance.updateScene?.({ elements: Array.from(byId.values()) as never })
      })
    },
    [absorb, withSuppressed],
  )

  const handleResync = useCallback(() => {
    // 全量重同步交给上层重拉一次画布（比在这里猜「漏了哪些」稳）
    onRemoteFullSyncRef.current()
  }, [])

  const collab = useCanvasCollab({
    canvasId,
    enabled: enabled && ready,
    onPatch: handlePatch,
    onResync: handleResync,
  })

  useEffect(() => {
    setParticipants(collab.participants)
  }, [collab.participants])

  /** 场景加载完成 / 切换画布：重置 diff 基线。 */
  const resetBaseline = useCallback(
    (elements: CanvasElement[]) => {
      reset(elements)
      baselineRef.current = canvasId
    },
    [reset, canvasId],
  )

  /* 画布切换：旧基线必须清掉，否则新场景会被算成「把旧元素全删了」 */
  useEffect(() => {
    if (baselineRef.current && baselineRef.current !== canvasId) {
      baselineRef.current = null
      reset([])
    }
  }, [canvasId, reset])

  /**
   * 本地上行：返回 true 表示已走协作通道（调用方应跳过整场景保存）。
   *
   * 没连上时返回 false —— 这是刻意的降级设计：协作不可用时，
   * 画布必须还能像以前那样整场景自动保存，而不是直接停止保存。
   */
  const { sendPatch, status: collabStatus } = collab
  const pushLocal = useCallback(
    (elements: CanvasElement[]): boolean => {
      if (baselineRef.current !== canvasId) {
        // 基线还没建立（刚加载完）：先记下，不上行
        reset(elements)
        baselineRef.current = canvasId
        return false
      }
      const patch = diff(elements)
      if (!patch) return collabStatus === 'online'
      return sendPatch(patch)
    },
    [canvasId, diff, reset, sendPatch, collabStatus],
  )

  const sendPresence = collab.sendPresence
  const requestResync = collab.requestResync
  const isLive = collab.status === 'online'
  const canWrite = collab.canWrite
  const version = collab.version

  /*
   * 返回对象必须 memo：调用方把它放进 `useCallback` 依赖里，
   * 每次渲染都换一个新对象会让 `handleChange` 每帧重建，
   * 进而把新的 onChange 一路传进 Excalidraw —— 画布会因此在拖拽时掉帧。
   */
  return useMemo(
    () => ({
      status: collab.status as CollabStatus,
      participants,
      canWrite,
      version,
      pushLocal,
      resetBaseline,
      sendPresence,
      requestResync,
      /** 协作通道是否真的在跑（决定要不要跳过整场景保存） */
      isLive,
    }),
    [
      collab.status,
      participants,
      canWrite,
      version,
      pushLocal,
      resetBaseline,
      sendPresence,
      requestResync,
      isLive,
    ],
  )
}

export type { CanvasState }
