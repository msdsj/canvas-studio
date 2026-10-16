import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Check, Crop, Loader2, Tag, Trash2, Zap } from 'lucide-react'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { CanvasExcali } from './CanvasExcali'
import { CanvasHeader } from './CanvasHeader'
import { CanvasToolbar } from './CanvasToolbar'
import { CanvasMinimap } from './CanvasMinimap'
import { CanvasMagicGenerator } from './CanvasMagicGenerator'
import { CanvasDoodle, type DoodleResult } from './CanvasDoodle'
import { ImagePreviewPanel } from './ImagePreviewPanel'
import {
  addImageToCanvas,
  buildMultiRegionSelection,
  buildRegionSelection,
  normalizeScene,
  type ExcalidrawApiLike,
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
import { assetsApi } from '@/lib/api/assets'
import { generateApi } from '@/lib/api/generate'
import { useCanvasStore } from '@/stores/canvas'
import { useUIStore } from '@/stores/ui'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { events } from '@/lib/events'
import { isTaskPlaced, markTaskPlaced, newIdempotencyKey } from '@/lib/task-persistence'
import { useTheme } from '@/hooks/use-theme'
import type { Asset, CanvasElement, CanvasState } from '@/types/models'

interface WorkspaceViewProps {
  initialCanvasId?: string
  sessionId?: string
  taskId?: string
}

/** 画布编辑模式下的区域标记（标签）：每个标记可独立发起「修改/透明化」，仅作用于该区域。 */
interface EditRegionTag {
  id: string
  /** 屏幕坐标（相对画布容器） */
  rect: { x: number; y: number; w: number; h: number }
  /** 归一化选区（相对原图，0-1） */
  region: { x: number; y: number; w: number; h: number }
  instruction: string
  status: 'draft' | 'submitted'
  /** 输入气泡是否展开（同一时间仅一个展开，避免气泡持续遮挡图片内容） */
  open: boolean
  /** 已提交任务 id（用于区域完成度检测与单区域重试） */
  taskId?: string
  /** 该区域在最近一次生成中未被实际修改（服务端逐区域检测结果） */
  warn?: boolean
}

/** 工作台主体：三栏（左工具 / 中画布 / 右对话）+ 移动端分段。 */
export function WorkspaceView({ initialCanvasId, sessionId = '', taskId }: WorkspaceViewProps) {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { resolved } = useTheme()
  const { canAfford, prices } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)

  const setCanvas = useCanvasStore((s) => s.setCanvas)
  const setSelected = useCanvasStore((s) => s.setSelectedElementIds)
  const mobileSegment = useUIStore((s) => s.mobileSegment)
  const leftbarCollapsed = useUIStore((s) => s.leftbarCollapsed)
  const toggleLeftbar = useUIStore((s) => s.toggleLeftbar)

  const [canvasId, setCanvasId] = useState<string | null>(initialCanvasId ?? null)
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | undefined>(undefined)
  const [api, setApi] = useState<ExcalidrawApiLike | null>(null)
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  const [pickerAssets, setPickerAssets] = useState<Asset[]>([])
  const [hasSelection, setHasSelection] = useState(false)
  const selectedImageRef = useRef<CanvasElement | null>(null)
  // 画布内框选编辑模式（画布直接框选 → 标签标记 → 通知对话框）
  const [editTarget, setEditTarget] = useState<{
    dataUrl: string
    imgRect: { x: number; y: number; w: number; h: number }
    sceneOrigin: { x: number; y: number; w: number; h: number }
  } | null>(null)
  const [editTags, setEditTags] = useState<EditRegionTag[]>([])
  const [editDraftRect, setEditDraftRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [tagBusyId, setTagBusyId] = useState<string | null>(null)
  // 涂鸦编辑模式 + 右栏图片预览
  const [selectedImageInfo, setSelectedImageInfo] = useState<{
    dataUrl: string
    width: number
    height: number
  } | null>(null)
  const [doodleTarget, setDoodleTarget] = useState<{
    dataUrl: string
    width: number
    height: number
  } | null>(null)
  const [doodleInstruction, setDoodleInstruction] = useState('')
  const [doodleSubmitting, setDoodleSubmitting] = useState(false)
  const editDragStartRef = useRef<{ x: number; y: number } | null>(null)
  const editOverlayRef = useRef<HTMLDivElement>(null)
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
  const lastSelectedFileIdRef = useRef<string | null>(null)

  const uploadInputRef = useRef<HTMLInputElement>(null)
  const latestSceneRef = useRef<CanvasState | null>(null)

  const autosave = useCanvasAutosave(canvasId)

  // 解析目标画布
  useEffect(() => {
    let active = true
    const resolve = async () => {
      try {
        if (initialCanvasId) {
          const canvas = await canvasesApi.get(initialCanvasId)
          if (!active) return
          setCanvas(canvas)
          setCanvasId(canvas.id)
          const scene = normalizeScene(canvas.state)
          latestSceneRef.current = scene
          setInitialData(scene as unknown as ExcalidrawInitialDataState)
          return
        }
        const projects = await projectsApi.list({ size: 1 })
        if (projects.items.length === 0) {
          const created = await projectsApi.create('我的第一个项目')
          const canvases = await projectsApi.listCanvases(created.id)
          if (!active || canvases.length === 0) return
          setCanvas(canvases[0])
          setCanvasId(canvases[0].id)
          const scene = normalizeScene(canvases[0].state)
          latestSceneRef.current = scene
          setInitialData(scene as unknown as ExcalidrawInitialDataState)
          return
        }
        const canvases = await projectsApi.listCanvases(projects.items[0].id)
        if (!active || canvases.length === 0) return
        setCanvas(canvases[0])
        setCanvasId(canvases[0].id)
        const scene = normalizeScene(canvases[0].state)
        latestSceneRef.current = scene
        setInitialData(scene as unknown as ExcalidrawInitialDataState)
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

  const handleChange = useCallback(
    (elements: CanvasState['elements'], files: Record<string, unknown>, appState: Record<string, unknown>) => {
      const scene: CanvasState = { elements, files, appState: { viewBackgroundColor: appState.viewBackgroundColor } }
      latestSceneRef.current = scene
      autosave.schedule(scene)
      const selected = (appState.selectedElementIds ?? {}) as Record<string, boolean>
      const selectedElement = elements.find((el) => el.type === 'image' && selected[el.id])
      setHasSelection(Boolean(selectedElement))
      selectedImageRef.current = selectedElement ?? null
      // 选中图片变化时同步右栏预览（dataUrl + 原图尺寸）
      const fileId = selectedElement?.fileId ?? null
      if (fileId !== lastSelectedFileIdRef.current) {
        lastSelectedFileIdRef.current = fileId
        if (selectedElement && fileId) {
          const dataUrl = (
            apiRef.current?.getFiles() as Record<string, { dataURL?: string } | undefined> | undefined
          )?.[fileId]?.dataURL
          if (dataUrl) {
            const probe = new Image()
            probe.onload = () =>
              setSelectedImageInfo({ dataUrl, width: probe.naturalWidth, height: probe.naturalHeight })
            probe.src = dataUrl
          } else {
            setSelectedImageInfo(null)
          }
        } else {
          setSelectedImageInfo(null)
        }
      }
      // 画布平移/缩放时，占位骨架的位置跟随刷新
      if (placeholdersRef.current.length > 0) refreshPhRef.current()
    },
    [autosave]
  )

  const handleApiReady = useCallback((instance: ExcalidrawApiLike) => setApi(instance), [])

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
      await addImageToCanvas(api, { url: asset.url, assetId: asset.id, width: asset.width, height: asset.height })
      setAssetPickerOpen(false)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleUploadFile = async (file: File) => {
    try {
      const asset = await assetsApi.upload(file)
      if (api) await addImageToCanvas(api, { url: asset.url, assetId: asset.id, width: asset.width, height: asset.height })
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleDeleteSelected = () => {
    if (!api) return
    const elements = api.getSceneElements()
    const appState = api.getAppState() as { selectedElementIds?: Record<string, boolean> }
    const selected = appState.selectedElementIds ?? {}
    api.updateScene({ elements: elements.filter((el) => !selected[el.id]) })
  }

  /** 下载选中图片原图。 */
  const handleDownloadImage = () => {
    if (!api) return
    const el = selectedImageRef.current
    if (!el?.fileId) return
    const files = api.getFiles() as Record<string, { dataURL?: string } | undefined>
    const dataUrl = files[el.fileId]?.dataURL
    if (!dataUrl) {
      toast.error(t('region.empty', { defaultValue: '未找到可编辑的图片' }))
      return
    }
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `canvas-image-${Date.now()}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  /** 进入涂鸦编辑模式（基于当前选中的图片）。 */
  const handleStartDoodle = () => {
    const el = selectedImageRef.current
    if (!el?.fileId) return
    const files = apiRef.current?.getFiles() as Record<string, { dataURL?: string } | undefined> | undefined
    const dataUrl = files?.[el.fileId]?.dataURL
    if (!dataUrl) {
      toast.error(t('region.empty', { defaultValue: '未找到可编辑的图片' }))
      return
    }
    const open = (w: number, h: number) => {
      setDoodleInstruction('')
      setDoodleTarget({ dataUrl, width: w, height: h })
    }
    if (selectedImageInfo?.dataUrl === dataUrl) {
      open(selectedImageInfo.width, selectedImageInfo.height)
      return
    }
    const probe = new Image()
    probe.onload = () => open(probe.naturalWidth, probe.naturalHeight)
    probe.src = dataUrl
  }

  /** 提交涂鸦：原图+涂鸦合成图 + 用户指令一并透传上游，笔迹包围盒作为编辑区域。 */
  const handleDoodleSubmit = async (result: DoodleResult) => {
    const target = doodleTarget
    if (!target) return
    if (!doodleInstruction.trim()) {
      toast.info(t('region.need_instruction', { defaultValue: '请先输入修改指令' }))
      return
    }
    setDoodleSubmitting(true)
    try {
      const task = await generateApi.edit(
        {
          prompt: doodleInstruction.trim(),
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file: result.file,
          region: [result.region],
        },
        newIdempotencyKey()
      )
      const el = selectedImageRef.current
      if (el) {
        pushPlaceholder(task.id, { x: el.x, y: el.y, w: el.width ?? 320, h: el.height ?? 320 })
      }
      setDoodleTarget(null)
      setDoodleInstruction('')
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.success(
        t('region.doodle_submitted', { defaultValue: '涂鸦标注已提交' }),
        t('region.submitted_desc', { defaultValue: '完成后结果将自动出现在画布上' })
      )
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setDoodleSubmitting(false)
    }
  }

  /** 结果卡「编辑」：载入生成图到内置编辑画布（免下载上传，含尺寸读取与状态提示）。 */
  useEffect(() => {
    const onOpen = (payload: { url: string }) => {
      if (!payload?.url) return
      const probe = new Image()
      probe.onload = () => {
        const info = {
          dataUrl: payload.url,
          width: probe.naturalWidth,
          height: probe.naturalHeight,
        }
        setSelectedImageInfo(info)
        setDoodleInstruction('')
        setDoodleTarget(info)
        toast.success(
          t('region.doodle_ready', { defaultValue: '已载入编辑画布' }),
          `${info.width} × ${info.height} px`
        )
      }
      probe.onerror = () => {
        toast.error(t('region.image_load_failed', { defaultValue: '图片载入失败，请重试' }))
      }
      probe.src = payload.url
    }
    events.on('edit:open', onOpen)
    return () => events.off('edit:open', onOpen)
  }, [t, toast])

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

  /** 双击画布图片 = 进入编辑框选模式（贴近主流设计工具的双击习惯）。 */
  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (editTarget) return
    const target = e.target as HTMLElement | null
    if (!target || target.tagName !== 'CANVAS') return
    if (selectedImageRef.current) handleMagicEdit()
  }

  const cancelEditMode = useCallback(() => {
    setEditTarget(null)
    setEditTags([])
    setEditDraftRect(null)
    setTagBusyId(null)
    editDragStartRef.current = null
  }, [])

  const handleMagicEdit = () => {
    if (!api) return
    const el = selectedImageRef.current
    if (!el || !el.fileId) {
      toast.info(t('region.need_image', { defaultValue: '请先在画布上选中一张图片' }))
      return
    }
    const files = api.getFiles() as Record<string, { dataURL?: string } | undefined>
    const dataUrl = files[el.fileId]?.dataURL
    if (!dataUrl) {
      toast.error(t('region.empty', { defaultValue: '未找到可编辑的图片' }))
      return
    }
    // 计算图片在画布容器中的显示区域（scene → viewport）
    const appState = api.getAppState() as { zoom?: { value?: number }; scrollX?: number; scrollY?: number }
    const zoom = appState.zoom?.value ?? 1
    const scrollX = appState.scrollX ?? 0
    const scrollY = appState.scrollY ?? 0
    const sx = (el as { scale?: [number, number] }).scale?.[0] ?? 1
    const sy = (el as { scale?: [number, number] }).scale?.[1] ?? 1
    const imgRect = {
      x: (el.x + scrollX) * zoom,
      y: (el.y + scrollY) * zoom,
      w: (el.width ?? 320) * zoom * sx,
      h: (el.height ?? 320) * zoom * sy,
    }
    setEditTarget({
      dataUrl,
      imgRect,
      sceneOrigin: { x: el.x, y: el.y, w: el.width ?? 320, h: el.height ?? 320 },
    })
    setEditTags([])
    setEditDraftRect(null)
    toast.info(
      t('region.canvas_mode', { defaultValue: '框选模式已开启' }),
      t('region.canvas_mode_desc', { defaultValue: '在图片上拖拽框选要修改的区域，可添加多个标记' })
    )
  }

  const editLocalPoint = (clientX: number, clientY: number) => {
    const el = editOverlayRef.current
    if (!el) return { x: 0, y: 0 }
    const b = el.getBoundingClientRect()
    return { x: clientX - b.left, y: clientY - b.top }
  }

  const updateTag = (id: string, patch: Partial<EditRegionTag>) => {
    setEditTags((tags) => tags.map((tag) => (tag.id === id ? { ...tag, ...patch } : tag)))
  }

  /** 点击数字标记：展开/收起对应输入气泡（同一时间仅一个展开）。 */
  const toggleTagOpen = (id: string) => {
    setEditTags((tags) =>
      tags.map((tag) => {
        if (tag.id === id) return { ...tag, open: !tag.open }
        return tag.open ? { ...tag, open: false } : tag
      })
    )
  }

  const removeTag = (id: string) => {
    setEditTags((tags) => tags.filter((tag) => tag.id !== id))
  }

  /** 把当前所有标记的区域一次性透明化（本地处理，免费）。 */
  const sendAllTransparent = async () => {
    if (!editTarget || tagBusyId) return
    const drafts = editTags.filter((tag) => tag.status === 'draft')
    if (drafts.length === 0) return
    setTagBusyId('__all__')
    try {
      const selection = await buildMultiRegionSelection(
        editTarget.dataUrl,
        drafts.map((tag) => tag.region)
      )
      const createdTask = await generateApi.edit(
        {
          prompt: t('region.transparent_prompt', { defaultValue: '将该框选区域内容处理为透明' }),
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file: selection.baseFile,
          region: selection.regions,
          mode: 'transparent',
        },
        newIdempotencyKey()
      )
      if (editTarget) pushPlaceholder(createdTask.id, editTarget.sceneOrigin)
      setEditTags((tags) =>
        tags.map((tag) =>
          tag.status === 'draft'
            ? {
                ...tag,
                status: 'submitted' as const,
                open: false,
                taskId: createdTask.id,
                warn: false,
              }
            : { ...tag, open: false }
        )
      )
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.success(
        t('region.submitted_transparent', { defaultValue: '透明化任务已提交' }),
        t('region.submitted_desc', { defaultValue: '完成后结果将自动出现在画布上' })
      )
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setTagBusyId(null)
    }
  }

  /** 全部发送：把所有标记的指令整理为分点列表，与「带编号红框的完整参考图」一次性发给上游。 */
  const sendAllTags = async () => {
    if (!editTarget || tagBusyId) return
    const drafts = editTags.filter((tag) => tag.status === 'draft')
    if (drafts.length === 0) return
    if (drafts.some((tag) => !tag.instruction.trim())) {
      toast.info(t('region.need_instruction', { defaultValue: '请先输入修改指令' }))
      return
    }
    if (!canAfford(prices.edit)) {
      setQuotaModalOpen(true)
      return
    }
    setTagBusyId('__all__')
    try {
      const selection = await buildMultiRegionSelection(
        editTarget.dataUrl,
        drafts.map((tag) => tag.region)
      )
      // 提示词 = 指定默认模板 + 编号分点（与红框图编号一一对应），原样透传上游
      const prompt = [
        t('region.multi_intro', {
          defaultValue:
            '请按照以下编号对应的提示词要求，修改图片中对应编号的红色框选区域，严格遵循每个编号对应的修改流程执行',
        }),
        ...drafts.map((tag, index) => `${index + 1}. ${tag.instruction.trim()}`),
      ].join('\n')
      const createdTask = await generateApi.edit(
        {
          prompt,
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file: selection.baseFile,
          mask: selection.maskFile,
          region: selection.regions,
        },
        newIdempotencyKey()
      )
      if (editTarget) pushPlaceholder(createdTask.id, editTarget.sceneOrigin)
      setEditTags((tags) =>
        tags.map((tag) =>
          tag.status === 'draft'
            ? {
                ...tag,
                status: 'submitted' as const,
                open: false,
                taskId: createdTask.id,
                warn: false,
              }
            : { ...tag, open: false }
        )
      )
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.success(
        t('region.submitted_edit', { defaultValue: '修改任务已提交' }),
        t('region.submitted_desc', { defaultValue: '完成后结果将自动出现在画布上' })
      )
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setTagBusyId(null)
    }
  }

  const handleEditPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editTarget) return
    // 点击画布任意位置时，直接收起已展开的输入气泡（不遮挡图片）
    setEditTags((tags) => {
      if (!tags.some((tag) => tag.open)) return tags
      return tags.map((tag) => (tag.open ? { ...tag, open: false } : tag))
    })
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = editLocalPoint(e.clientX, e.clientY)
    editDragStartRef.current = p
    setEditDraftRect({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const handleEditPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editDragStartRef.current) return
    const s = editDragStartRef.current
    const p = editLocalPoint(e.clientX, e.clientY)
    setEditDraftRect({
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    })
  }

  const handleEditPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editDragStartRef.current || !editTarget) return
    const s = editDragStartRef.current
    editDragStartRef.current = null
    setEditDraftRect(null)
    const p = editLocalPoint(e.clientX, e.clientY)
    const raw = {
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    }
    if (raw.w < 12 || raw.h < 12) return
    if (editTags.length >= 8) {
      toast.info(t('region.tags_limit', { defaultValue: '最多支持 8 个标记，请先处理已有标记' }))
      return
    }
    const { imgRect } = editTarget
    if (imgRect.w <= 0 || imgRect.h <= 0) return
    const x1 = Math.max(raw.x, imgRect.x)
    const y1 = Math.max(raw.y, imgRect.y)
    const x2 = Math.min(raw.x + raw.w, imgRect.x + imgRect.w)
    const y2 = Math.min(raw.y + raw.h, imgRect.y + imgRect.h)
    if (x2 - x1 < 8 || y2 - y1 < 8) return
    const region = {
      x: (x1 - imgRect.x) / imgRect.w,
      y: (y1 - imgRect.y) / imgRect.h,
      w: (x2 - x1) / imgRect.w,
      h: (y2 - y1) / imgRect.h,
    }
    setEditTags((tags) => [
      ...tags.map((tag) => (tag.open ? { ...tag, open: false } : tag)),
      {
        id: crypto.randomUUID(),
        rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
        region,
        instruction: '',
        status: 'draft',
        open: true,
      },
    ])
  }

  // ESC 退出框选模式
  useEffect(() => {
    if (!editTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelEditMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editTarget, cancelEditMode])

  const handleAddResultToCanvas = async (url: string, taskIdInner: string) => {
    if (!api) return
    try {
      await addImageToCanvas(api, { url })
      markTaskPlaced(taskIdInner)
      toast.success(t('task.add_to_canvas'))
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  // 生成结果自动落画布：画布就绪与任务状态变化时，把当前画布已成功且未落过的结果自动补到画布（P0-08）
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
              await addImageToCanvas(api, { url })
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
    return () => {
      cancelled = true
      events.off('tasks:changed', onTasksChanged)
    }
  }, [api, canvasId, sessionId])

  /** 重算占位骨架的屏幕坐标（画布平移/缩放时跟随；无变化时保持原引用，避免多余渲染）。 */
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
        if (
          ph.screenX === screenX &&
          ph.screenY === screenY &&
          ph.screenW === screenW &&
          ph.screenH === screenH
        ) {
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

  // 占位跟踪：定期刷新位置 + 查询任务状态；完成后在原位渲染结果（无需刷新页面）
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
            await addImageToCanvas(api, { url: task.result_urls[0], x: ph.sceneX, y: ph.sceneY })
            markTaskPlaced(task.id)
            setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
            // 区域完成度检测：部分区域未被实际修改时打警告标记，支持单独重试
            const checks = (task.params as Record<string, unknown> | undefined)?.region_check as
              | Array<{ index: number; changed: boolean }>
              | undefined
            let partial = false
            if (checks && checks.length > 1) {
              const failed = checks.filter((c) => !c.changed).map((c) => c.index)
              if (failed.length > 0) {
                partial = true
                setEditTags((prevTags) => {
                  const relatedIds = prevTags
                    .filter((item) => item.taskId === task.id)
                    .map((item) => item.id)
                  const failedIds = new Set(
                    failed.map((idx) => relatedIds[idx]).filter((id): id is string => Boolean(id))
                  )
                  if (failedIds.size === 0) return prevTags
                  return prevTags.map((item) => (failedIds.has(item.id) ? { ...item, warn: true } : item))
                })
              }
            }
            if (partial) {
              toast.error(
                t('region.partial_warning', {
                  defaultValue: '部分区域未能完成修改，点击对应数字标记可单独重试',
                })
              )
            } else {
              toast.success(t('region.generated', { defaultValue: '生成完成，结果已放到画布' }))
            }
          } else if (task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled') {
            setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
            toast.error(
              task.error_message || t('region.gen_failed', { defaultValue: '生成未完成，额度已退回' })
            )
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
    // 仅在"有无占位"切换时重建；t/toast 由闭包持有，稳定引用不参与依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, placeholders.length === 0 ? 0 : 1, refreshPlaceholderPositions])

  /** 单区域重试：仅提交该标记区域的修改（用于多区域生成中未被完成的区域）。 */
  const retryTag = async (tag: EditRegionTag) => {
    if (!editTarget || tagBusyId) return
    if (!tag.instruction.trim()) {
      toast.info(t('region.need_instruction', { defaultValue: '请先输入修改指令' }))
      return
    }
    if (!canAfford(prices.edit)) {
      setQuotaModalOpen(true)
      return
    }
    setTagBusyId(tag.id)
    try {
      const selection = await buildRegionSelection(editTarget.dataUrl, tag.region)
      const prompt = [
        t('region.multi_intro', {
          defaultValue:
            '请按照以下编号对应的提示词要求，修改图片中对应编号的红色框选区域，严格遵循每个编号对应的修改流程执行',
        }),
        `1. ${tag.instruction.trim()}`,
      ].join('\n')
      const createdTask = await generateApi.edit(
        {
          prompt,
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file: selection.baseFile,
          mask: selection.maskFile,
          region: tag.region,
        },
        newIdempotencyKey()
      )
      if (editTarget) pushPlaceholder(createdTask.id, editTarget.sceneOrigin)
      setEditTags((tags) =>
        tags.map((item) =>
          item.id === tag.id
            ? {
                ...item,
                status: 'submitted' as const,
                open: false,
                warn: false,
                taskId: createdTask.id,
              }
            : item
        )
      )
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.success(
        t('region.submitted_edit', { defaultValue: '修改任务已提交' }),
        t('region.submitted_desc', { defaultValue: '完成后结果将自动出现在画布上' })
      )
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setTagBusyId(null)
    }
  }

  const handleSessionChange = (id: string) => {
    void navigate({ to: '/workspace', search: { session: id, task: taskId } as never, replace: true })
  }

  const draftTagCount = editTags.filter((tag) => tag.status === 'draft').length

  return (
    <div className="flex h-full flex-col">
      <MobileSegmented />
      <CanvasDoodle
        open={!!doodleTarget}
        imageDataUrl={doodleTarget?.dataUrl ?? ''}
        imageWidth={doodleTarget?.width ?? 1}
        imageHeight={doodleTarget?.height ?? 1}
        submitting={doodleSubmitting}
        instruction={doodleInstruction}
        onInstructionChange={setDoodleInstruction}
        onCancel={() => setDoodleTarget(null)}
        onSubmit={(result) => void handleDoodleSubmit(result)}
        onError={(message) => toast.error(message)}
      />
      <div className="flex min-h-0 flex-1">
        {mobileSegment === 'canvas' && (
          <WorkspaceLeftbar
            collapsed={leftbarCollapsed}
            onAddImage={openAssetPicker}
            onUpload={() => uploadInputRef.current?.click()}
          />
        )}

        {mobileSegment === 'canvas' && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between px-2">
              <CanvasHeader canvasId={canvasId} onShare={handleShare} />
              <button
                type="button"
                onClick={toggleLeftbar}
                className="hidden px-2 text-xs text-text-tertiary md:inline"
              >
                {leftbarCollapsed ? '展开' : '收起'}
              </button>
            </div>
            <div className="relative min-h-0 flex-1 bg-bg-subtle" onDoubleClick={handleCanvasDoubleClick}>
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
              {hasSelection && !editTarget && (
                <CanvasMagicGenerator
                  onMagicEdit={handleMagicEdit}
                  onDoodle={handleStartDoodle}
                  onDownload={handleDownloadImage}
                  onDelete={handleDeleteSelected}
                />
              )}
              {editTarget && (
                <div
                  ref={editOverlayRef}
                  className="absolute inset-0 z-30 touch-none"
                  style={{ cursor: 'crosshair' }}
                  onPointerDown={handleEditPointerDown}
                  onPointerMove={handleEditPointerMove}
                  onPointerUp={handleEditPointerUp}
                >
                  <div className="pointer-events-none absolute left-1/2 top-16 z-20 flex max-w-[calc(100%-16px)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-md border border-border bg-surface/95 px-3 py-1.5 text-xs text-text-secondary shadow-md">
                    <Crop size={13} />
                    <span className="whitespace-nowrap">
                      {t('region.canvas_hint', { defaultValue: '框选并写指令，点【发送】提交全部（ESC 退出）' })}
                    </span>
                    {draftTagCount > 0 && (
                      <>
                        <button
                          type="button"
                          className="pointer-events-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-brand px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50"
                          disabled={!!tagBusyId}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => void sendAllTags()}
                        >
                          <Zap size={12} />
                          {t('region.send_all', { defaultValue: '发送' })}
                          {` (${draftTagCount})`}
                        </button>
                        <button
                          type="button"
                          className="pointer-events-auto inline-flex shrink-0 items-center whitespace-nowrap rounded border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                          disabled={!!tagBusyId}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => void sendAllTransparent()}
                        >
                          {t('region.send_transparent', { defaultValue: '透明化' })}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="pointer-events-auto shrink-0 whitespace-nowrap text-brand-text hover:underline"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={cancelEditMode}
                    >
                      {t('region.finish', { defaultValue: '完成' })}
                    </button>
                  </div>
                  {editDraftRect && editDraftRect.w > 1 && editDraftRect.h > 1 && (
                    <div
                      className="pointer-events-none absolute"
                      style={{
                        left: editDraftRect.x,
                        top: editDraftRect.y,
                        width: editDraftRect.w,
                        height: editDraftRect.h,
                        border: '2px dashed rgba(255, 32, 32, 0.95)',
                        background: 'rgba(255, 64, 64, 0.12)',
                      }}
                    />
                  )}
                  {editTags.map((tag, index) => {
                    const submitted = tag.status === 'submitted'
                    const overlayW = editOverlayRef.current?.clientWidth ?? 900
                    const overlayH = editOverlayRef.current?.clientHeight ?? 600
                    // 气泡优先放选框右侧（避免遮挡后续框选），放不下换左侧，再不行放下方
                    let bubbleLeft = tag.rect.x + tag.rect.w + 8
                    if (bubbleLeft + 248 > overlayW) bubbleLeft = tag.rect.x - 248
                    if (bubbleLeft < 8) {
                      bubbleLeft = Math.max(8, Math.min(tag.rect.x, overlayW - 248))
                    }
                    const bubbleTop = Math.max(8, Math.min(tag.rect.y, overlayH - 175))
                    return (
                      <div key={tag.id}>
                        {/* 选框：展开时醒目实线，收起时为淡色虚线（减少对图片内容的遮挡） */}
                        <div
                          className="pointer-events-none absolute"
                          style={{
                            left: tag.rect.x,
                            top: tag.rect.y,
                            width: tag.rect.w,
                            height: tag.rect.h,
                            border: `${tag.open ? '2px solid' : '1.5px dashed'} ${
                              submitted
                                ? `rgba(34, 197, 94, ${tag.open ? '0.95' : '0.55'})`
                                : `rgba(255, 32, 32, ${tag.open ? '0.95' : '0.55'})`
                            }`,
                            background: tag.open
                              ? submitted
                                ? 'rgba(34, 197, 94, 0.10)'
                                : 'rgba(255, 64, 64, 0.15)'
                              : 'transparent',
                          }}
                        />
                        {/* 数字标记（常驻、可点击重新编辑）：骑在选框左上角，不遮挡内容主体 */}
                        <button
                          type="button"
                          title={tag.instruction || undefined}
                          className="absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-white shadow-md transition-transform hover:scale-110"
                          style={{
                            left: tag.rect.x,
                            top: tag.rect.y,
                            background: tag.warn
                              ? 'rgba(245, 158, 11, 0.98)'
                              : submitted
                                ? 'rgba(34, 197, 94, 0.98)'
                                : 'rgba(239, 68, 68, 0.98)',
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => toggleTagOpen(tag.id)}
                        >
                          {index + 1}
                        </button>
                        {tag.open && (
                        <div
                          className="absolute z-10 w-[240px] rounded-lg border border-border bg-surface px-2.5 py-2 text-xs shadow-lg"
                          style={{ left: bubbleLeft, top: bubbleTop }}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                            {submitted ? (
                              <div>
                                <div className="flex items-center justify-between">
                                  <span
                                    className={`flex items-center gap-1 font-medium ${
                                      tag.warn ? 'text-warning' : 'text-success'
                                    }`}
                                  >
                                    {tag.warn ? (
                                      <>
                                        <AlertTriangle size={12} />{' '}
                                        {t('region.tag_incomplete', { defaultValue: '该区域未完成修改' })}
                                      </>
                                    ) : (
                                      <>
                                        <Check size={12} />{' '}
                                        {t('region.tag_submitted', { defaultValue: '已提交，生成中…' })}
                                      </>
                                    )}
                                  </span>
                                  <button
                                    type="button"
                                    className="text-text-tertiary hover:text-danger"
                                    onClick={() => removeTag(tag.id)}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                                <div className="mt-1.5 flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="rounded bg-brand px-2 py-0.5 text-[11px] font-medium text-text-inverse hover:opacity-90 disabled:opacity-50"
                                    disabled={!!tagBusyId}
                                    onClick={() => void retryTag(tag)}
                                  >
                                    {tag.warn
                                      ? t('region.retry_region', { defaultValue: '单独重试' })
                                      : t('region.regen_region', { defaultValue: '重新生成此区域' })}
                                  </button>
                                </div>
                              </div>
                            ) : (
                            <>
                              <div className="flex items-center justify-between">
                                <span className="flex items-center gap-1 font-medium text-text">
                                  <Tag size={12} /> {t('region.tag_label', { defaultValue: '标记' })} {index + 1}
                                </span>
                                <button
                                  type="button"
                                  className="text-text-tertiary hover:text-danger"
                                  onClick={() => removeTag(tag.id)}
                                >
                                  <Trash2 size={12} />
                                </button>
                              </div>
                              <textarea
                                value={tag.instruction}
                                onChange={(e) => updateTag(tag.id, { instruction: e.target.value })}
                                placeholder={t('region.tag_placeholder', {
                                  defaultValue: '描述如何修改此区域（仅该区域生效）',
                                })}
                                rows={2}
                                className="mt-1.5 w-full resize-none rounded border border-border bg-bg-subtle px-1.5 py-1 text-xs text-text placeholder:text-text-tertiary focus:border-brand focus:outline-none"
                              />
                            </>
                          )}
                        </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
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
              onDoodle={handleStartDoodle}
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

      <input
        ref={uploadInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleUploadFile(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
