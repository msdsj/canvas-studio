import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import type { ExcalidrawApiLike } from './canvas-helpers'
import type { CanvasElement } from '@/types/models'

interface CanvasExcaliProps {
  initialData?: ExcalidrawInitialDataState
  theme?: 'light' | 'dark'
  viewMode?: boolean
  onApiReady?: (api: ExcalidrawApiLike) => void
  onChange?: (elements: CanvasElement[], files: Record<string, unknown>, appState: Record<string, unknown>) => void
}

/**
 * Excalidraw 画布核心（拖拽/缩放/框选/层级由 Excalidraw 提供）。
 * 移植自 jaaz CanvasExcali，改造为对接 backend 的 PATCH /canvases/{id} 自动保存。
 */
export function CanvasExcali({ initialData, theme = 'light', viewMode, onApiReady, onChange }: CanvasExcaliProps) {
  const apiRef = useRef<ExcalidrawApiLike | null>(null)
  const initialRef = useRef(initialData)

  const handleApi = useCallback(
    (api: unknown) => {
      apiRef.current = api as ExcalidrawApiLike
      onApiReady?.(api as ExcalidrawApiLike)
    },
    [onApiReady]
  )

  const handleChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      onChange?.(
        elements as CanvasElement[],
        (files as Record<string, unknown>) ?? {},
        (appState as Record<string, unknown>) ?? {}
      )
    },
    [onChange]
  )

  // 主题切换时同步 Excalidraw 主题
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    try {
      api.updateScene({ elements: api.getSceneElements() })
    } catch {
      /* ignore */
    }
  }, [theme])

  const data = useMemo(() => initialRef.current ?? null, [])

  return (
    <div className="h-full w-full">
      <Excalidraw
        initialData={data}
        theme={theme}
        viewModeEnabled={viewMode}
        excalidrawAPI={handleApi}
        onChange={handleChange}
      />
    </div>
  )
}
