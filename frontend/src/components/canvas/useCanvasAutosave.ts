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

  const flush = useCallback(async () => {
    if (!canvasId || !pendingRef.current) return
    const state = pendingRef.current
    pendingRef.current = null
    setSaveStatus('saving')
    try {
      await canvasesApi.update(canvasId, { state })
      markSaved()
    } catch {
      setSaveStatus('error')
    }
  }, [canvasId, setSaveStatus, markSaved])

  const schedule = useCallback(
    (state: CanvasState) => {
      pendingRef.current = state
      setSaveStatus('dirty')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void flush(), 2000)
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

  return { schedule, flush }
}
