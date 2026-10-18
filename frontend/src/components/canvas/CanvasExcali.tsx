import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { adoptImageFiles, fitSceneToViewport, type ExcalidrawApiLike } from './canvas-helpers'
import type { CanvasElement } from '@/types/models'

interface CanvasExcaliProps {
  initialData?: ExcalidrawInitialDataState
  theme?: 'light' | 'dark'
  viewMode?: boolean
  onApiReady?: (api: ExcalidrawApiLike) => void
  onChange?: (elements: CanvasElement[], files: Record<string, unknown>, appState: Record<string, unknown>) => void
}

/**
 * Excalidraw 内部用于显示网格/背景的「主题底色」变量。
 *
 * 注入 `transparent` 是有意为之：Excalidraw 会把 appState.viewBackgroundColor
 * 同时用于画布像素与这一层 CSS 变量；直接改成主题色会让它亮→暗切换时
 * 把画布刷成一块死板的纯色，盖住纸纹与暗色下的受光边。
 */
const EXCALIDRAW_BG_VAR = 'transparent'


/**
 * Excalidraw 未设置背景色时的出厂值。
 * 自动保存会把它原样写进画布 appState，因此「#ffffff」在库里既可能是出厂值、
 * 也可能是用户主动选的白色——视觉语言 v2 里画布底色由 `--color-canvas` 统一决定，
 * 两者都按「没有自定义背景」处理，交给 CSS 透出纸感底色。
 */
const EXCALIDRAW_FACTORY_BG = new Set(['#ffffff', '#fff', 'white', 'rgb(255,255,255)', 'rgb(255, 255, 255)'])

/**
 * 决定画布底色。
 *
 * 只有「用户明确选过一个非出厂色」时才原样保留；其余情况一律用 `transparent`——
 * Excalidraw 对 `transparent` 走 `clearRect`（见其内部 `canvasBackground` 绘制逻辑），
 * 画布像素留空，于是 `.cs-canvas-shell` 的 `--color-canvas` 自然透出来，
 * 亮色是暖米 #F0EBE1、暗色是墨黑 #0E0C0A，不用改后端也不用随主题重写场景。
 */
function resolveViewBackgroundColor(stored: unknown): string {
  if (typeof stored !== 'string') return 'transparent'
  const value = stored.trim()
  if (!value) return 'transparent'
  if (EXCALIDRAW_FACTORY_BG.has(value.toLowerCase())) return 'transparent'
  return value
}

/**
 * Excalidraw 画布核心（拖拽/缩放/框选/层级由 Excalidraw 提供）。
 * 移植自 jaaz CanvasExcali，改造为对接 backend 的 PATCH /canvases/{id} 自动保存。
 */
export function CanvasExcali({ initialData, theme = 'light', viewMode, onApiReady, onChange }: CanvasExcaliProps) {
  const { i18n } = useTranslation()
  /**
   * Excalidraw 的界面语言必须跟着应用走。
   *
   * 之前没传 `langCode`，它回落到英文：侧边栏一打开就是 Open / Save to… /
   * Export image… / Reset the canvas / Excalidraw links 一整片英文，
   * 与站内中文界面割裂。这个属性是 Excalidraw 唯一的语言开关。
   */
  const langCode = i18n.language?.startsWith('en') ? 'en' : 'zh-CN'
  const apiRef = useRef<ExcalidrawApiLike | null>(null)
  const initialRef = useRef(initialData)
  const fitFrameRef = useRef<number | null>(null)
  /** 外层容器：首帧量它的尺寸来算初始 zoom（Excalidraw 挂载后 appState 尺寸还是 0） */
  const shellRef = useRef<HTMLDivElement>(null)

  const scheduleInitialFit = useCallback((api: ExcalidrawApiLike) => {
    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
    let attempts = 0
    const run = () => {
      fitFrameRef.current = null
      let elements: CanvasElement[] = []
      try {
        elements = api.getSceneElements()
      } catch {
        return
      }
      /**
       * 挂载回调触发时 initialData 还没并进场景（getSceneElements 返回空数组），
       * 此时算出来的就是「空画布 zoom=1」，等于把内容顶到看不见的角落。
       * 所以等到场景真的有元素再适配；没有内容就什么都不做。
       */
      if (elements.length === 0 && attempts < 240) {
        attempts += 1
        fitFrameRef.current = requestAnimationFrame(run)
        return
      }
      if (elements.length === 0) return
      const rect = shellRef.current?.getBoundingClientRect()
      fitSceneToViewport(
        api,
        elements,
        {},
        rect && rect.width > 0 && rect.height > 0
          ? { width: rect.width, height: rect.height }
          : undefined
      )
    }
    fitFrameRef.current = requestAnimationFrame(() => requestAnimationFrame(run))
  }, [])

  useEffect(() => {
    return () => {
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current)
    }
  }, [])

  const handleApi = useCallback(
    (api: unknown) => {
      apiRef.current = api as ExcalidrawApiLike
      onApiReady?.(api as ExcalidrawApiLike)
      scheduleInitialFit(api as ExcalidrawApiLike)
    },
    [onApiReady, scheduleInitialFit]
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

  /**
 * 初始数据用 Excalidraw 官方 restoreElements 规范化。
 * 我们持久化的是自造的元素对象（缺 index/fractionalIndex 等 0.18 必需字段），
 * 直接塞给 Excalidraw 会被 restore 阶段整体丢弃 → 刷新后画布一片空白。
 */
const data = useMemo(() => {
    const src = initialRef.current as unknown as
      | { elements?: unknown[]; files?: Record<string, unknown>; appState?: Record<string, unknown> }
      | undefined
    if (!src) return null
    try {
      const rawElements = Array.isArray(src.elements) ? (src.elements as CanvasElement[]) : []
      // 先把「自己存的 fileId」转成 Excalidraw 认的命名，否则图片元素会补不上尺寸
      const adopted = adoptImageFiles(
        rawElements,
        (src.files ?? {}) as Record<string, unknown>
      )
      const elements = restoreElements(adopted.elements as never[], null)
      const storedAppState = (src.appState ?? {}) as Record<string, unknown>
      /**
       * 剥离历史视口参数。
       *
       * 之前把后端存的 appState 整个铺开塞给 initialData，等于让上一次会话的
       * zoom（可能是 2.0+）、scrollX/scrollY 决定这次打开的画面：小屏或窗口变窄后
       * 就是「画布炸开、看不到内容、也缩不回去」。视口一律不继承，交给挂载后的
       * `fitSceneToViewport` 按当前容器重新计算。
       */
      const { zoom: _zoom, scrollX: _scrollX, scrollY: _scrollY, ...restAppState } = storedAppState
      return {
        elements,
        appState: {
          ...restAppState,
          zoom: { value: 1 },
          scrollX: 0,
          scrollY: 0,
          viewBackgroundColor: resolveViewBackgroundColor(storedAppState.viewBackgroundColor),
        } as never,
        files: adopted.files as never,
      }
    } catch {
      return { elements: [], appState: {} as never, files: {} as never }
    }
  }, [])

  return (
    <div ref={shellRef} className="cs-canvas-shell h-full min-h-0 w-full">
      <Excalidraw
        initialData={data}
        theme={theme}
        langCode={langCode as never}
        viewModeEnabled={viewMode}
        excalidrawAPI={handleApi}
        onChange={handleChange}
        /**
         * 兜底底色：Excalidraw 出厂 appState 带 `viewBackgroundColor: '#ffffff'`，
         * 场景为空（initialData.appState 缺这个键）或用户之前存过出厂白时，
         * 不加这一层就会在容器上盖出一块不透明的白，纸感底色全丢。
         */
        style={{ ['--default-bg-color' as string]: EXCALIDRAW_BG_VAR }}
        /**
         * 只保留画布内该有的动作。
         *
         * 文件类（打开/另存/导出）与「重置画布」「画布背景」都由平台自己的
         * 工具栏与主题系统接管，留在 Excalidraw 菜单里只会产生两套并行入口，
         * 而且它的导出导的是整块画布，跟我们「导出选中图片」语义冲突。
         */
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
            clearCanvas: false,
            changeViewBackgroundColor: false,
            toggleTheme: false,
          },
        }}
      />
    </div>
  )
}
