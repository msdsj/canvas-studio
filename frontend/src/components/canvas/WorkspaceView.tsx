import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { CanvasExcali } from './CanvasExcali'
import { CanvasHeader } from './CanvasHeader'
import { CanvasToolbar } from './CanvasToolbar'
import { CanvasMinimap } from './CanvasMinimap'
import { ImageEditLayer } from './ImageEditLayer'
import { LayerPanel } from './LayerPanel'
import { UploadPromptDialog } from './UploadPromptDialog'
import { ImagePreviewPanel } from './ImagePreviewPanel'
import {
  addImageToCanvas,
  downloadImageAs,
  elementImageDataUrl,
  elementScreenRect,
  normalizeScene,
  viewportCenterScene,
  type ExcalidrawApiLike,
  type NormRegion,
} from './canvas-helpers'
import { useCanvasAutosave } from './useCanvasAutosave'
import { WorkspaceLeftbar } from '@/components/layout/WorkspaceLeftbar'
import { WorkspaceRightPanel } from '@/components/layout/WorkspaceRightPanel'
import { MobileSegmented } from '@/components/layout/MobileSegmented'
import { Modal } from '@/components/ui/modal'
import { AssetGrid } from '@/components/assets/AssetGrid'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { projectsApi } from '@/lib/api/projects'
import { canvasesApi } from '@/lib/api/canvases'
import { assetsApi, type PromptPreset } from '@/lib/api/assets'
import { generateApi } from '@/lib/api/generate'
import { useCanvasStore } from '@/stores/canvas'
import { useUIStore } from '@/stores/ui'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { events } from '@/lib/events'
import { isTaskPlaced, markTaskPlaced, newIdempotencyKey } from '@/lib/task-persistence'
import { useTheme } from '@/hooks/use-theme'
import { cn } from '@/lib/utils'
import type { Asset, CanvasElement, CanvasState } from '@/types/models'

interface WorkspaceViewProps {
  initialCanvasId?: string
  sessionId?: string
  taskId?: string
}

/** 编辑目标：画布上被单击选中的图片。 */
interface EditTarget {
  elementId: string
  dataUrl: string
  width: number
  height: number
  /** 该图的内置提示词（上传时配置 / 生成时的提示词），进入编辑自动回填 */
  presetPrompt: string
}

const CLICK_MOVE_TOLERANCE = 5
const CLICK_MAX_MS = 700

/**
 * 场景签名：`id:version:opacity:locked` 序列。
 * Excalidraw 每次 onChange 都会给出新的数组引用，若不加判断就 setState，
 * 会造成「onChange → setState → 重渲染 → onChange」的无限更新（React 直接抛
 * Maximum update depth exceeded）。用签名做内容级比较，只有真正变化才落 state。
 */
function sceneSignature(list: CanvasElement[]): string {
  let out = ''
  for (const el of list) {
    const item = el as { version?: number; opacity?: number; locked?: boolean }
    out += `${el.id}:${item.version ?? 0}:${item.opacity ?? 100}:${item.locked ? 1 : 0}|`
  }
  return out
}

/** 工作台主体：三栏（左工具+图层 / 中画布 / 右对话）。 */
export function WorkspaceView({ initialCanvasId, sessionId = '', taskId }: WorkspaceViewProps) {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { resolved } = useTheme()
  const { canAfford, prices } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)

  const setCanvas = useCanvasStore((s) => s.setCanvas)
  const mobileSegment = useUIStore((s) => s.mobileSegment)
  const leftbarCollapsed = useUIStore((s) => s.leftbarCollapsed)
  const toggleLeftbar = useUIStore((s) => s.toggleLeftbar)

  const [canvasId, setCanvasId] = useState<string | null>(initialCanvasId ?? null)
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | undefined>(undefined)
  const [api, setApi] = useState<ExcalidrawApiLike | null>(null)
  const [elements, setElements] = useState<CanvasElement[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // 编辑模式（单击选中图片即进入）
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [editRect, setEditRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [editPrompt, setEditPrompt] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)

  // 内置提示词配置
  const [promptTemplate, setPromptTemplate] = useState('')
  const [presets, setPresets] = useState<PromptPreset[]>([])

  // 上传（含提示词配置）
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)

  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [pickerAssets, setPickerAssets] = useState<Asset[]>([])

  // 生成占位（骨架屏）：任务提交后在画布上立即占位，完成后在原位渲染结果
  const [placeholders, setPlaceholders] = useState<
    Array<{
      taskId: string
      sceneX: number
      sceneY: number
      sceneW: number
      sceneH: number
      screenX: number
      screenY: number
      screenW: number
      screenH: number
    }>
  >([])
  const placeholdersRef = useRef<typeof placeholders>([])
  useEffect(() => {
    placeholdersRef.current = placeholders
  }, [placeholders])
  const refreshPhRef = useRef<() => void>(() => {})
  const apiRef = useRef<ExcalidrawApiLike | null>(null)
  apiRef.current = api
  const selectedImageRef = useRef<CanvasElement | null>(null)
  const editTargetRef = useRef<EditTarget | null>(null)
  editTargetRef.current = editTarget
  const clickStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  /** 上一次同步到 state 的场景签名 / 选中签名（防止 onChange 无限回灌） */
  const sceneSigRef = useRef('')
  const selectionSigRef = useRef('')
  /** 资产 id → 内置提示词（避免重复请求） */
  const assetPromptRef = useRef<Record<string, string>>({})

  const uploadInputRef = useRef<HTMLInputElement>(null)
  const latestSceneRef = useRef<CanvasState | null>(null)

  const autosave = useCanvasAutosave(canvasId)

  const selectedImage = useMemo(
    () => elements.find((el) => el.type === 'image' && selectedIds.includes(el.id)) ?? null,
    [elements, selectedIds]
  )

  const [selectedImageInfo, setSelectedImageInfo] = useState<{
    dataUrl: string
    width: number
    height: number
    prompt: string
  } | null>(null)

  // 解析目标画布
  useEffect(() => {
    let active = true
    const apply = (state: CanvasState | null | undefined) => {
      const scene = normalizeScene(state)
      latestSceneRef.current = scene
      sceneSigRef.current = sceneSignature(scene.elements)
      setElements(scene.elements)
      setInitialData(scene as unknown as ExcalidrawInitialDataState)
    }
    const resolve = async () => {
      try {
        if (initialCanvasId) {
          const canvas = await canvasesApi.get(initialCanvasId)
          if (!active) return
          setCanvas(canvas)
          setCanvasId(canvas.id)
          apply(canvas.state)
          return
        }
        const projects = await projectsApi.list({ size: 1 })
        if (projects.items.length === 0) {
          const created = await projectsApi.create('我的第一个项目')
          const canvases = await projectsApi.listCanvases(created.id)
          if (!active || canvases.length === 0) return
          setCanvas(canvases[0])
          setCanvasId(canvases[0].id)
          apply(canvases[0].state)
          return
        }
        const canvases = await projectsApi.listCanvases(projects.items[0].id)
        if (!active || canvases.length === 0) return
        setCanvas(canvases[0])
        setCanvasId(canvases[0].id)
        apply(canvases[0].state)
      } catch (error) {
        toast.error(errorMessage(error, te))
      }
    }
    void resolve()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCanvasId])

  // 内置提示词配置（模板 + 预设）
  useEffect(() => {
    let active = true
    assetsApi
      .promptPresets()
      .then((res) => {
        if (!active) return
        setPromptTemplate(res.template ?? '')
        setPresets(Array.isArray(res.presets) ? res.presets : [])
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const handleChange = useCallback(
    (nextElements: CanvasState['elements'], files: Record<string, unknown>, appState: Record<string, unknown>) => {
      const scene: CanvasState = {
        elements: nextElements,
        files,
        appState: { viewBackgroundColor: appState.viewBackgroundColor },
      }
      latestSceneRef.current = scene
      autosave.schedule(scene)
      // 只有内容真正变化才写入 state（否则会触发 React 无限更新）
      const sig = sceneSignature(nextElements)
      if (sig !== sceneSigRef.current) {
        sceneSigRef.current = sig
        setElements(nextElements)
      }
      const selected = (appState.selectedElementIds ?? {}) as Record<string, boolean>
      const ids = Object.keys(selected).filter((id) => selected[id])
      const selSig = ids.join('|')
      if (selSig !== selectionSigRef.current) {
        selectionSigRef.current = selSig
        setSelectedIds(ids)
      }
      const image = nextElements.find((el) => el.type === 'image' && selected[el.id]) ?? null
      selectedImageRef.current = image
      // 编辑目标被取消选中 → 退出编辑模式
      const current = editTargetRef.current
      if (current && !nextElements.some((el) => el.id === current.elementId && selected[el.id])) {
        setEditTarget(null)
        setEditRect(null)
      }
      // 画布平移/缩放时，编辑层与占位骨架的位置跟随刷新
      if (editTargetRef.current) {
        const target = nextElements.find((el) => el.id === editTargetRef.current?.elementId) ?? null
        const rect = elementScreenRect(apiRef.current, target)
        if (rect) {
          setEditRect((prev) =>
            prev && prev.x === rect.x && prev.y === rect.y && prev.w === rect.w && prev.h === rect.h
              ? prev
              : rect
          )
        }
      }
      if (placeholdersRef.current.length > 0) refreshPhRef.current()
    },
    [autosave]
  )

  const handleApiReady = useCallback((instance: ExcalidrawApiLike) => setApi(instance), [])

  /** 读取图片原始尺寸。 */
  const probeSize = (dataUrl: string) =>
    new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
      img.onerror = () => reject(new Error('image load failed'))
      img.src = dataUrl
    })

  /** 解析元素内置提示词：上传时配置的提示词 / 生成该图时的提示词。 */
  const resolvePresetPrompt = async (element: CanvasElement): Promise<string> => {
    const custom = (element.customData ?? {}) as Record<string, unknown>
    const inline = typeof custom.prompt === 'string' ? custom.prompt : ''
    if (inline) return inline
    const assetId = typeof custom.assetId === 'string' ? custom.assetId : ''
    if (!assetId) return ''
    if (assetPromptRef.current[assetId] !== undefined) return assetPromptRef.current[assetId]
    try {
      const asset = await assetsApi.get(assetId)
      assetPromptRef.current[assetId] = asset.source_prompt ?? ''
    } catch {
      assetPromptRef.current[assetId] = ''
    }
    return assetPromptRef.current[assetId]
  }

  /** 进入编辑模式（单击选中图片即触发）。 */
  const enterEdit = useCallback(async (element: CanvasElement) => {
    const instance = apiRef.current
    const dataUrl = elementImageDataUrl(instance, element)
    if (!dataUrl) {
      toast.error('该图片尚未加载完成，请稍后重试')
      return
    }
    try {
      const { w, h } = await probeSize(dataUrl)
      const presetPrompt = await resolvePresetPrompt(element)
      setEditPrompt(presetPrompt)
      setEditTarget({ elementId: element.id, dataUrl, width: w, height: h, presetPrompt })
      setEditRect(elementScreenRect(apiRef.current, element))
    } catch {
      toast.error('图片载入失败，请重试')
    }
  }, [toast])

  const exitEdit = useCallback(() => {
    setEditTarget(null)
    setEditRect(null)
    setEditPrompt('')
  }, [])

  /** 单击（无拖拽位移）选中图片 → 进入编辑模式。 */
  const handlePointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    clickStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() }
  }

  const handlePointerUpCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = clickStartRef.current
    clickStartRef.current = null
    if (!start) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MOVE_TOLERANCE) return
    if (Date.now() - start.time > CLICK_MAX_MS) return
    // 等 Excalidraw 完成选中态更新后再判断
    window.setTimeout(() => {
      const element = selectedImageRef.current
      if (!element) return
      if (editTargetRef.current?.elementId === element.id) return
      void enterEdit(element)
    }, 0)
  }

  // ESC 退出编辑模式
  useEffect(() => {
    if (!editTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitEdit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editTarget, exitEdit])

  // 选中图片变化时同步右栏预览（dataUrl + 原图尺寸 + 内置提示词）
  useEffect(() => {
    let alive = true
    if (!selectedImage) {
      setSelectedImageInfo(null)
      return
    }
    const dataUrl = elementImageDataUrl(apiRef.current, selectedImage)
    if (!dataUrl) {
      setSelectedImageInfo(null)
      return
    }
    void (async () => {
      try {
        const { w, h } = await probeSize(dataUrl)
        const prompt = await resolvePresetPrompt(selectedImage)
        if (alive) setSelectedImageInfo({ dataUrl, width: w, height: h, prompt })
      } catch {
        if (alive) setSelectedImageInfo(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [selectedImage])

  const openAssetPicker = async () => {
    setAssetPickerOpen(true)
    try {
      const page = await assetsApi.list({ size: 40 })
      setPickerAssets(page.items)
    } catch {
      setPickerAssets([])
    }
  }

  const useAsset = async (asset: Asset) => {
    if (!api) return
    try {
      assetPromptRef.current[asset.id] = asset.source_prompt ?? ''
      await addImageToCanvas(api, {
        url: asset.url,
        assetId: asset.id,
        name: asset.source_prompt?.slice(0, 20) || '素材图片',
        width: asset.width,
        height: asset.height,
      })
      setAssetPickerOpen(false)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  /** 上传确认：携带内置提示词一起入库，并加入画布。 */
  const handleUploadConfirm = async (prompt: string) => {
    const file = uploadFile
    if (!file) return
    setUploading(true)
    try {
      const asset = await assetsApi.upload(file, prompt)
      assetPromptRef.current[asset.id] = prompt
      if (api) {
        await addImageToCanvas(api, {
          url: asset.url,
          assetId: asset.id,
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 20) || '上传图片',
          width: asset.width,
          height: asset.height,
        })
      }
      setUploadFile(null)
      toast.success('图片已上传并加入画布', '单击图片即可开始编辑')
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setUploading(false)
    }
  }

  const handleDeleteElement = (id: string) => {
    if (!api) return
    if (editTargetRef.current?.elementId === id) exitEdit()
    api.updateScene({ elements: api.getSceneElements().filter((el) => el.id !== id) })
  }

  const handleDeleteSelected = () => {
    if (!api) return
    const appState = api.getAppState() as { selectedElementIds?: Record<string, boolean> }
    const selected = appState.selectedElementIds ?? {}
    api.updateScene({ elements: api.getSceneElements().filter((el) => !selected[el.id]) })
  }

  /** 下载当前选中图片（PNG / JPG）。 */
  const handleDownloadSelected = async (format: 'png' | 'jpg') => {
    const dataUrl = selectedImageInfo?.dataUrl
    if (!dataUrl) {
      toast.error('未找到可下载的图片')
      return
    }
    try {
      await downloadImageAs(dataUrl, format, 'canvas-image')
    } catch {
      toast.error('下载失败，请重试')
    }
  }

  const handleShare = async () => {
    if (!canvasId) return
    try {
      const result = await canvasesApi.share(canvasId)
      await navigator.clipboard.writeText(result.url).catch(() => undefined)
      toast.success(t('canvas:share.title', { defaultValue: '分享链接已复制' }), result.url)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleSessionChange = (id: string) => {
    void navigate({ to: '/workspace', search: { session: id, task: taskId } as never, replace: true })
  }

  const handleAddResultToCanvas = async (url: string, taskIdInner: string) => {
    if (!api) return
    try {
      await addImageToCanvas(api, { url, ...viewportCenterScene(api, 320, 320) })
      markTaskPlaced(taskIdInner)
      toast.success(t('task.add_to_canvas'))
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  // 生成结果自动落画布：画布就绪与任务状态变化时，把当前画布已成功且未落过的结果自动补到画布
  const autoPlaceLockRef = useRef(false)
  const autoPlaceLastRunRef = useRef(0)
  useEffect(() => {
    if (!api || !canvasId) return
    let cancelled = false
    const placeResults = async () => {
      if (autoPlaceLockRef.current) return
      const now = Date.now()
      if (now - autoPlaceLastRunRef.current < 3000) return
      autoPlaceLastRunRef.current = now
      autoPlaceLockRef.current = true
      try {
        const page = await generateApi.listTasks({
          session_id: sessionId || undefined,
          status: 'succeeded',
          size: 20,
        })
        if (cancelled) return
        const pending = (page.items ?? []).filter(
          (task) =>
            task.status === 'succeeded' &&
            task.result_urls.length > 0 &&
            (task.canvas_id === canvasId || (!task.canvas_id && !!sessionId && task.session_id === sessionId)) &&
            !isTaskPlaced(task.id) &&
            !placeholdersRef.current.some((ph) => ph.taskId === task.id)
        )
        for (const task of pending) {
          try {
            for (const url of task.result_urls) {
              // 落在当前视口中心：保证结果一出现就在眼前
              await addImageToCanvas(api, {
                url,
                name: task.prompt.slice(0, 20),
                ...viewportCenterScene(api, 320, 320),
              })
            }
            markTaskPlaced(task.id)
          } catch {
            break // 落图失败不标记，留待下次任务变更时重试
          }
        }
      } catch {
        /* 自动补投递失败静默处理，不打断用户操作 */
      } finally {
        autoPlaceLockRef.current = false
      }
    }
    void placeResults()
    const onTasksChanged = () => void placeResults()
    events.on('tasks:changed', onTasksChanged)
    // 兜底轮询：任务完成时前端不一定 emit('tasks:changed')，没有兜底会出现"生成成功但图没落到画布"
    const timer = window.setInterval(() => void placeResults(), 8000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      events.off('tasks:changed', onTasksChanged)
    }
  }, [api, canvasId, sessionId])

  /** 重算占位骨架的屏幕坐标（画布平移/缩放时跟随）。 */
  const refreshPlaceholderPositions = useCallback(() => {
    if (!api || placeholdersRef.current.length === 0) return
    const appState = api.getAppState() as { zoom?: { value?: number }; scrollX?: number; scrollY?: number }
    const zoom = appState.zoom?.value ?? 1
    const scrollX = appState.scrollX ?? 0
    const scrollY = appState.scrollY ?? 0
    setPlaceholders((prev) => {
      let changed = false
      const next = prev.map((ph) => {
        const screenX = (ph.sceneX + scrollX) * zoom
        const screenY = (ph.sceneY + scrollY) * zoom
        const screenW = ph.sceneW * zoom
        const screenH = ph.sceneH * zoom
        if (ph.screenX === screenX && ph.screenY === screenY && ph.screenW === screenW && ph.screenH === screenH) {
          return ph
        }
        changed = true
        return { ...ph, screenX, screenY, screenW, screenH }
      })
      return changed ? next : prev
    })
  }, [api])
  refreshPhRef.current = refreshPlaceholderPositions

  /** 任务提交后：在当前图片右侧占位（结果将渲染在该位置）。 */
  const pushPlaceholder = (taskId: string, base: { x: number; y: number; w: number; h: number }) => {
    if (!api) return
    const appState = api.getAppState() as { zoom?: { value?: number }; scrollX?: number; scrollY?: number }
    const zoom = appState.zoom?.value ?? 1
    const scrollX = appState.scrollX ?? 0
    const scrollY = appState.scrollY ?? 0
    const sceneW = 320
    const sceneH = base.w > 0 && base.h > 0 ? Math.round((320 * base.h) / base.w) : 320
    const sceneX = base.x + base.w + 60
    const sceneY = base.y
    setPlaceholders((prev) => [
      ...prev,
      {
        taskId,
        sceneX,
        sceneY,
        sceneW,
        sceneH,
        screenX: (sceneX + scrollX) * zoom,
        screenY: (sceneY + scrollY) * zoom,
        screenW: sceneW * zoom,
        screenH: sceneH * zoom,
      },
    ])
  }

  // 占位跟踪：定期刷新位置 + 查询任务状态；完成后在原位渲染结果
  useEffect(() => {
    if (!api || placeholders.length === 0) return
    let cancelled = false
    const tick = async () => {
      refreshPlaceholderPositions()
      for (const ph of placeholdersRef.current) {
        try {
          const task = await generateApi.getTask(ph.taskId)
          if (cancelled) return
          if (task.status === 'succeeded' && task.result_urls.length > 0) {
            await addImageToCanvas(api, {
              url: task.result_urls[0],
              name: task.prompt.slice(0, 20),
              x: ph.sceneX,
              y: ph.sceneY,
            })
            markTaskPlaced(task.id)
            setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
            toast.success(t('region.generated', { defaultValue: '生成完成，结果已放到画布' }))
          } else if (task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled') {
            setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
            toast.error(task.error_message || t('region.gen_failed', { defaultValue: '生成未完成，额度已退回' }))
          }
        } catch {
          /* 网络抖动忽略，下一轮重试 */
        }
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, placeholders.length === 0 ? 0 : 1, refreshPlaceholderPositions])

  /** 编辑确认：把「带框选标记的图 + 用户提示词」发送上游执行图生图。 */
  const handleEditSubmit = async (payload: {
    baseFile: File
    maskFile: File | null
    regions: NormRegion[]
    prompt: string
  }) => {
    const target = editTargetRef.current
    if (!target) return
    if (!canAfford(prices.edit)) {
      setQuotaModalOpen(true)
      return
    }
    setEditSubmitting(true)
    try {
      const prompt = payload.regions.length > 0 && promptTemplate
        ? `${promptTemplate}\n${payload.prompt}`
        : payload.prompt
      const task = await generateApi.edit(
        {
          prompt,
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file: payload.baseFile,
          mask: payload.maskFile ?? undefined,
          region: payload.regions,
        },
        newIdempotencyKey()
      )
      const element = apiRef.current?.getSceneElements().find((el) => el.id === target.elementId)
      if (element) {
        pushPlaceholder(task.id, {
          x: element.x ?? 0,
          y: element.y ?? 0,
          w: element.width ?? 320,
          h: element.height ?? 320,
        })
      }
      exitEdit()
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.success('修改任务已提交', '完成后结果会自动出现在画布上')
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setEditSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <MobileSegmented />
      <div className="flex min-h-0 flex-1">
        {mobileSegment === 'canvas' && (
          <WorkspaceLeftbar
            collapsed={leftbarCollapsed}
            onAddImage={openAssetPicker}
            onUpload={() => uploadInputRef.current?.click()}
            layersSlot={
              <LayerPanel
                api={api}
                elements={elements}
                selectedIds={selectedIds}
                onElementSelected={(element) => {
                  // Excalidraw 的程序化 updateScene 不会触发 onChange，
                  // 这里手动同步选中态，保证图层面板 ↔ 画布双向一致
                  selectionSigRef.current = element.id
                  setSelectedIds([element.id])
                  // 与画布单击保持一致：选中图片即进入编辑模式
                  if (element.type === 'image' && editTargetRef.current?.elementId !== element.id) {
                    void enterEdit(element)
                  }
                }}
                collapsed={leftbarCollapsed}
              />
            }
          />
        )}

        {mobileSegment === 'canvas' && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between px-2">
              <CanvasHeader canvasId={canvasId} api={api} onShare={handleShare} />
              <button
                type="button"
                onClick={toggleLeftbar}
                className="hidden px-2 text-xs text-text-tertiary md:inline"
              >
                {leftbarCollapsed ? '展开' : '收起'}
              </button>
            </div>
            <div
              className={cn(
                'relative min-h-0 flex-1 bg-bg-subtle',
                // 选中图片时隐藏 Excalidraw 原生「双击裁剪」提示：
                // 本平台的图片编辑统一由单击进入编辑层，避免两个冲突的图片编辑入口
                selectedImage && 'cs-has-image-selected'
              )}
              onPointerDownCapture={handlePointerDownCapture}
              onPointerUpCapture={handlePointerUpCapture}
              onDoubleClickCapture={(e) => {
                if (!selectedImageRef.current) return
                e.preventDefault()
                e.stopPropagation()
              }}
            >
              {initialData !== undefined ? (
                <CanvasExcali
                  initialData={initialData}
                  theme={resolved}
                  onApiReady={handleApiReady}
                  onChange={handleChange}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-text-tertiary">
                  {t('canvas:empty.title', { defaultValue: '画布加载中…' })}
                </div>
              )}
              <CanvasToolbar api={api} onAddImage={openAssetPicker} onDeleteSelected={handleDeleteSelected} />
              <CanvasMinimap />
              {placeholders.map((ph) => (
                <div
                  key={ph.taskId}
                  className="pointer-events-none absolute z-10 flex animate-pulse items-center justify-center rounded-lg border-2 border-dashed border-border-strong bg-surface-hover/70"
                  style={{ left: ph.screenX, top: ph.screenY, width: ph.screenW, height: ph.screenH }}
                >
                  <div className="flex flex-col items-center gap-2 text-text-tertiary">
                    <Loader2 size={22} className="animate-spin" />
                    <span className="text-xs">{t('region.generating', { defaultValue: '生成中…' })}</span>
                  </div>
                </div>
              ))}
              {/* 编辑层：单击图片即进入，精确贴合原图位置 */}
              <ImageEditLayer
                open={!!editTarget}
                dataUrl={editTarget?.dataUrl ?? ''}
                naturalWidth={editTarget?.width ?? 1}
                naturalHeight={editTarget?.height ?? 1}
                imgRect={editRect}
                submitting={editSubmitting}
                prompt={editPrompt}
                onPromptChange={setEditPrompt}
                promptTemplate={promptTemplate}
                presets={presets}
                onClose={exitEdit}
                onSubmit={(payload) => void handleEditSubmit(payload)}
                onDelete={() => {
                  const id = editTargetRef.current?.elementId
                  if (id) handleDeleteElement(id)
                }}
                onError={(message) => toast.error(message)}
              />
            </div>
          </div>
        )}

        {mobileSegment === 'chat' && (
          <div className="min-h-0 flex-1 md:hidden">
            <ChatPanel
              canvasId={canvasId ?? undefined}
              sessionId={sessionId || null}
              onSessionChange={handleSessionChange}
              onAddResultToCanvas={handleAddResultToCanvas}
            />
          </div>
        )}

        <div className="hidden md:flex">
          <WorkspaceRightPanel open>
            <ImagePreviewPanel
              imageUrl={selectedImageInfo?.dataUrl ?? null}
              width={selectedImageInfo?.width}
              height={selectedImageInfo?.height}
              prompt={selectedImageInfo?.prompt}
              onEdit={() => {
                if (selectedImage) void enterEdit(selectedImage)
              }}
              onDownload={(format) => void handleDownloadSelected(format)}
              onDelete={() => {
                if (selectedImage) handleDeleteElement(selectedImage.id)
              }}
            />
            <ChatPanel
              canvasId={canvasId ?? undefined}
              sessionId={sessionId || null}
              onSessionChange={handleSessionChange}
              onAddResultToCanvas={handleAddResultToCanvas}
            />
          </WorkspaceRightPanel>
        </div>
      </div>

      <Modal
        open={assetPickerOpen}
        onOpenChange={setAssetPickerOpen}
        title={t('assets:title', { defaultValue: '选择素材' })}
        size="lg"
      >
        <div className="max-h-[60vh] overflow-y-auto">
          <AssetGrid assets={pickerAssets} onUse={useAsset} />
        </div>
      </Modal>

      <UploadPromptDialog
        open={!!uploadFile}
        file={uploadFile}
        presets={presets}
        uploading={uploading}
        onConfirm={(prompt) => void handleUploadConfirm(prompt)}
        onCancel={() => setUploadFile(null)}
      />

      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) setUploadFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
