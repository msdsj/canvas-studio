import { useCallback, useEffect, useRef } from 'react'
import { canvasesApi } from '@/lib/api/canvases'
import { useCanvasStore } from '@/stores/canvas'
import type { CanvasState } from '@/types/models'

/** 防抖 2s 自动保存 + 保存态。 */
export function useCanvasAutosave(canvasId: string | null) {
  const setSaveStatus = useCanvasStore((s) => s.setSaveStatus)
  const markSaved = useCanvasStore((s) => s.markSaved)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<CanvasState | null>(null)
  /**
   * 场景已加载完成之前，一律不写盘。
   *
   * 画布还在「加载中」时 Excalidraw 会先报一次空场景的 onChange，
   * 若照单保存，两秒后就把后端的真实内容覆盖成空画布（实测整块画布被清空）。
   * 加载完成由调用方用 `setReady(true)` 打开闸门。
   */
  const readyRef = useRef(false)
  const setReady = useCallback((ready: boolean) => {
    readyRef.current = ready
    if (!ready && timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      pendingRef.current = null
    }
  }, [])

  /** 保存失败后的重试次数：成功即清零，延迟按指数退避（上限 30s）。 */
  const retryRef = useRef(0)
  /** 指向最新的 flush：失败重试的定时器通过它回调，避免自引用闭包。 */
  const flushRef = useRef<() => void>(() => {})

  const flush = useCallback(async () => {
    if (!canvasId || !pendingRef.current) return
    const state = pendingRef.current
    pendingRef.current = null
    setSaveStatus('saving')
    try {
      await canvasesApi.update(canvasId, { state })
      retryRef.current = 0
      markSaved()
    } catch {
      // 保存失败绝不能把这段编辑丢掉：放回 pending 并指数退避重试。
      // 否则断网 / 后端抖动时这一版内容会被静默抹掉，刷新后不复存在。
      if (!pendingRef.current) pendingRef.current = state
      setSaveStatus('error')
      retryRef.current += 1
      const delay = Math.min(4000 * 2 ** (retryRef.current - 1), 30000)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        flushRef.current()
      }, delay)
    }
  }, [canvasId, setSaveStatus, markSaved])
  flushRef.current = () => void flush()

  /**
   * 丢弃待写内容：清掉防抖定时器与 pending 场景。
   *
   * 切换画布时必须「先 flush 再 cancel」——flush 把旧画布的编辑落盘，
   * cancel 保证定时器不会在画布 id 已经换掉之后再把旧场景写进新画布。
   */
  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    retryRef.current = 0
  }, [])

  const schedule = useCallback(
    (state: CanvasState) => {
      // 闸门没开（场景尚未加载完）时丢弃：宁可少存一次，也不能把内容覆盖成空
      if (!readyRef.current) return
      pendingRef.current = state
      setSaveStatus('dirty')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void flush()
      }, 2000)
    },
    [flush, setSaveStatus]
  )

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      // 卸载时尝试刷写
      void flush()
    }
  }, [flush])

  return { schedule, flush, cancel, setReady }
}
