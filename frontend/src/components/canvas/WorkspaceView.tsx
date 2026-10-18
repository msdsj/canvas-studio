import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Images, Link2, Loader2, Upload } from 'lucide-react'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { CanvasMinimap } from './CanvasMinimap'
import { CanvasExcali } from './CanvasExcali'
import { CanvasHeader } from './CanvasHeader'
import { CanvasToolbar } from './CanvasToolbar'
import { ImageEditLayer, type ImageEditLayerHandle } from './ImageEditLayer'
import {
  clearEditDraft,
  clearEditDraftsForElement,
  editDraftKey,
} from './edit-draft'
import { LayerPanel } from './LayerPanel'
import { UploadPromptDialog } from './UploadPromptDialog'
import { ImagePreviewPanel } from './ImagePreviewPanel'
import { StudioSidebar } from '@/components/studio/StudioSidebar'
import { WorkspaceIdentityBar } from '@/components/layout/WorkspaceIdentityBar'
import {
  addImageToCanvas,
  allSceneElements,
  downloadImageAs,
  elementImageDataUrl,
  elementScreenRect,
  findEmptySpot,
  focusSceneBox,
  imageSize,
  normalizeScene,
  sceneSourceUrls,
  unplacedResultUrls,
  urlToDataUrl,
  type ExcalidrawApiLike,
  type NormRegion,
} from './canvas-helpers'
import { useCanvasAutosave } from './useCanvasAutosave'
import { MobileSegmented } from '@/components/layout/MobileSegmented'
import { Modal } from '@/components/ui/modal'
import { AssetGrid } from '@/components/assets/AssetGrid'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { projectsApi } from '@/lib/api/projects'
import { canvasesApi } from '@/lib/api/canvases'
import { chatApi } from '@/lib/api/chat'
import { assetsApi, type PromptPreset } from '@/lib/api/assets'
import { generateApi, type EditCapability, type EditOpPayload } from '@/lib/api/generate'
import { apiUrl } from '@/lib/api/client'
import { useCanvasStore } from '@/stores/canvas'
import { useUIStore } from '@/stores/ui'
import { useComposerHandoff } from '@/stores/composer'
import { useComposerRefs, MAX_COMPOSER_REFS } from '@/stores/composer-refs'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { events } from '@/lib/events'
import {
  loadPlacedUrls,
  markTaskPlaced,
  markUrlPlaced,
  newIdempotencyKey,
} from '@/lib/task-persistence'
import { useTheme } from '@/hooks/use-theme'
import { panelLadder, useReveal } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { Asset, CanvasElement, CanvasState } from '@/types/models'
import type { CanvasSelectionContext, SelectionRegionContext } from '@/types/selection'

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
  /** 该图在后端资产库中的 id；用于把画布选区上下文交给侧栏做需求分析 */
  assetId?: string
  /** 编辑草稿键（元素 id + 图片指纹）：退出/切换后再进来按它恢复选区与提示词 */
  draftKey: string
}

const CLICK_MOVE_TOLERANCE = 5
const CLICK_MAX_MS = 700
/** 结果落画布时的单张最大边长 / 最小边长 / 相邻间距（多产出横向排布）。 */
const RESULT_MAX_SIDE = 320
const RESULT_MIN_SIDE = 80
const RESULT_GAP = 40

/**
 * 把一次任务的全部产出横向排布到画布上。
 *
 * 一次编辑任务可能产出多张（如「1 张完整修改图 + N 张透明素材」），
 * 必须逐张投放——只投第一张却把任务标记为「已投放」，会造成其余结果被兜底
 * 逻辑永久跳过，用户看到的现象就是「明明框了抠图，却没抠出来」。
 */
async function placeTaskResults(
  api: ExcalidrawApiLike,
  task: { prompt: string; result_urls: string[] },
  origin: { x: number; y: number },
  canvasId?: string | null
): Promise<number> {
  // 逐张去重：一次任务可能产出「1 张整图 + N 张素材」。若中途某张拉取失败，
  // 下一轮轮询会重来——不按 url 去重就会把已经落过的图重复叠到画布上。
  const todo = unplacedResultUrls(api, task.result_urls, loadPlacedUrls(canvasId))
  let cursorX = origin.x
  for (const url of todo) {
    const size = await imageSize(url)
    const scale = Math.min(1, RESULT_MAX_SIDE / Math.max(size.width, size.height, 1))
    const width = Math.max(RESULT_MIN_SIDE, Math.round(size.width * scale))
    const height = Math.max(RESULT_MIN_SIDE, Math.round(size.height * scale))
    await addImageToCanvas(api, {
      url,
      assetId: await materializeResultAsset(url),
      name: task.prompt.slice(0, 20),
      width,
      height,
      x: cursorX,
      y: origin.y,
    })
    // 落一张登记一张：这样中途失败后的重试只补没落的，不会重复
    markUrlPlaced(url, canvasId)
    cursorX += width + RESULT_GAP
  }
  return todo.length
}

/**
 * 自动落图：把一批结果放进视口内**不重叠**的空位，返回新建元素以便聚焦。
 *
 * 与 `placeTaskResults`（编辑任务在原占位处渲染）的区别：位置不是固定占位点，
 * 而是逐个 `findEmptySpot` 找空位——自动落图不能盖住用户正在排布的画布。
 */
async function placeResultSet(
  api: ExcalidrawApiLike,
  urls: string[],
  name: string,
  canvasId?: string | null
): Promise<CanvasElement[]> {
  const created: CanvasElement[] = []
  for (const url of urls) {
    const size = await imageSize(url)
    const scale = Math.min(1, RESULT_MAX_SIDE / Math.max(size.width, size.height, 1))
    const width = Math.max(RESULT_MIN_SIDE, Math.round(size.width * scale))
    const height = Math.max(RESULT_MIN_SIDE, Math.round(size.height * scale))
    const spot = findEmptySpot(api, width, height)
    // 先登记资产（失败也照常落图）：带着 assetId 落进画布，后续 @ 引用 / 编辑免去回传
    const assetId = await materializeResultAsset(url)
    const element = await addImageToCanvas(api, {
      url,
      assetId,
      name,
      width,
      height,
      x: spot.x,
      y: spot.y,
    })
    created.push(element)
    markUrlPlaced(url, canvasId)
  }
  return created
}

/** 生成结果图已登记的资产 id（按 url 缓存）：同一张图只回传一次。 */
const resultAssetCache: Record<string, string> = {}

/**
 * 把生成结果回传进资产库，拿到资产 id。
 *
 * 为什么要这一步：上游只回一个临时 URL，图片本身并没有进我们的资产库。
 * 结果图一旦落进画布，它就该是**一等公民**——能被 @ 引用、能进编辑/抠图、
 * 能作为下一次图生图的底图。带着 assetId 落图，后续所有链路都免去重复回传。
 * 失败返回 undefined：落图本身照常完成（画布上仍然看得到、也能编辑），
 * 只是这条捷径没走上，后续引用时再补登记。
 */
async function materializeResultAsset(url: string): Promise<string | undefined> {
  const cached = resultAssetCache[url]
  if (cached) return cached
  try {
    const dataUrl = await urlToDataUrl(url)
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], 'ai-result.png', { type: blob.type || 'image/png' })
    const asset = await assetsApi.upload(file)
    resultAssetCache[url] = asset.id
    return asset.id
  } catch {
    return undefined
  }
}

/** 一组元素的包围盒（scene 坐标），用于落图后聚焦。 */
function unionBox(elements: CanvasElement[]): { x: number; y: number; w: number; h: number } | null {
  let box: { x: number; y: number; w: number; h: number } | null = null
  for (const el of elements) {
    const x = el.x ?? 0
    const y = el.y ?? 0
    const w = el.width ?? 0
    const h = el.height ?? 0
    if (w <= 0 || h <= 0) continue
    if (!box) {
      box = { x, y, w, h }
      continue
    }
    const right = Math.max(box.x + box.w, x + w)
    const bottom = Math.max(box.y + box.h, y + h)
    box.x = Math.min(box.x, x)
    box.y = Math.min(box.y, y)
    box.w = right - box.x
    box.h = bottom - box.y
  }
  return box
}

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
  const setProjectName = useCanvasStore((s) => s.setProjectName)
  // 选中态同步到 store：CanvasHeader 的「导出」据此高亮，避免两处各算一套
  const setStoreSelectedIds = useCanvasStore((s) => s.setSelectedElementIds)
  const mobileSegment = useUIStore((s) => s.mobileSegment)

  const shellRef = useRef<HTMLDivElement>(null)
  /** 首页交接下来的一句话 + 参考图：交给右侧对话面板自动提交（只消费一次） */
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null)
  const [initialFiles, setInitialFiles] = useState<File[]>([])
  const handoffRef = useRef(false)

  const [canvasId, setCanvasId] = useState<string | null>(initialCanvasId ?? null)
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | undefined>(undefined)
  const [api, setApi] = useState<ExcalidrawApiLike | null>(null)
  const [elements, setElements] = useState<CanvasElement[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  /** 上抛给侧栏「需求分析中转站」的选区上下文；没有编辑目标时为 null */
  const [selectionCtx, setSelectionCtx] = useState<CanvasSelectionContext | null>(null)

  // 编辑模式（单击选中图片即进入）
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  const [editRect, setEditRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [editPrompt, setEditPrompt] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)

  // 内置提示词配置
  const [promptTemplate, setPromptTemplate] = useState('')
  const [presets, setPresets] = useState<PromptPreset[]>([])
  /** 可用编辑能力（后端注册表驱动，前端不写死；拉取失败时组件内用最小兜底） */
  const [editCapabilities, setEditCapabilities] = useState<EditCapability[]>([])

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
  /** 画布元素 id → 资产 id（进入编辑时补全，避免同一张图重复上传） */
  const assetIdRef = useRef<Record<string, string>>({})
  /** 切换画布序号：快速连点时只让最后一次响应生效，防止串数据 */
  const switchSeqRef = useRef(0)
  /** 编辑层句柄：向侧栏提供并集掩码 PNG */
  const editLayerRef = useRef<ImageEditLayerHandle | null>(null)
  /** 结果落画布失败的次数（按任务）：连续失败到阈值就收掉骨架，避免假「生成中…」 */
  const placeFailuresRef = useRef<Record<string, number>>({})

  const uploadInputRef = useRef<HTMLInputElement>(null)
  const latestSceneRef = useRef<CanvasState | null>(null)

  const autosave = useCanvasAutosave(canvasId)
  const setAutosaveReady = autosave.setReady
  /**
   * Excalidraw 挂载后会先报一次「空场景」onChange（initialData 还没并进场景）。
   * 这一次绝不能落盘：它会把刚读出来的内容覆盖成空画布。
   * applyScene 之后先用这个标记挡住该事件，等真实场景回灌后再放开。
   */
  const holdAutosaveRef = useRef(false)

  // 首页交接：取走那句话（消费后即清空，刷新不会重复提交）
  useEffect(() => {
    if (handoffRef.current) return
    handoffRef.current = true
    const pending = useComposerHandoff.getState().consume()
    if (!pending.text) return
    setInitialPrompt(pending.text)
    setInitialFiles(pending.files)
  }, [])

  /**
   * 入场：三块面板依次落位（左栏 → 画布 → 对话）。
   *
   * 不给三栏同一套参数：位移量与延迟都随层级递减（左栏抬得最高、对话最轻），
   * 视觉上像三张纸从前到后依次压下来；如果三块齐步走、位移一致，
   * 就只是一次「整页淡入」，没有纵深。
   */
  useReveal(shellRef, {
    selector: '[data-panel]',
    ...panelLadder(0),
    stagger: 0.085,
    duration: 0.62,
    delay: 0.02,
  })

  const selectedImage = useMemo(
    () => elements.find((el) => el.type === 'image' && selectedIds.includes(el.id)) ?? null,
    [elements, selectedIds]
  )

  /** 至少选中了一张图片：只有这时「导出」才可用（导出的是选中的图，不是整块画布） */
  const hasImageSelected = useMemo(
    () => elements.some((el) => el.type === 'image' && selectedIds.includes(el.id)),
    [elements, selectedIds]
  )

  useEffect(() => {
    setStoreSelectedIds(selectedIds)
  }, [selectedIds, setStoreSelectedIds])

  const [selectedImageInfo, setSelectedImageInfo] = useState<{
    dataUrl: string
    width: number
    height: number
  } | null>(null)

  /** 把服务端场景灌入画布（同时刷新签名，避免 onChange 立刻回灌）。 */
  const applyScene = useCallback((state: CanvasState | null | undefined) => {
    const scene = normalizeScene(state)
    latestSceneRef.current = scene
    sceneSigRef.current = sceneSignature(scene.elements)
    setElements(scene.elements)
    setInitialData(scene as unknown as ExcalidrawInitialDataState)
    // 场景已就位：现在才允许把 onChange 的结果写回后端（见 useCanvasAutosave 的闸门）
    setAutosaveReady(true)
    holdAutosaveRef.current = true
  }, [setAutosaveReady])

  /** 退出图片编辑：同时清空选区上下文，避免侧栏拿着过期选区继续发消息。 */
  const exitEdit = useCallback(() => {
    setEditTarget(null)
    setEditRect(null)
    setEditPrompt('')
    setSelectionCtx(null)
  }, [])

  /**
   * 切换画布：旧场景先落盘 → 清空本地状态 → 拉取新场景。
   *
   * 顺序不能动：先 flush 再 cancel，保证旧画布的编辑不会因为防抖定时器在
   * 新画布 id 生效后才触发而被写进新画布；清空 initialData 让画布回到
   * 「画布加载中…」占位，配合 `<CanvasExcali key={canvasId}>` 的重建清空撤销栈。
   */
  const switchCanvas = useCallback(
    async (targetId: string) => {
      const seq = ++switchSeqRef.current
      await autosave.flush()
      autosave.cancel()
      // 新场景尚未到达：关闸，避免 Excalidraw 重建时的空场景把新画布写成空
      setAutosaveReady(false)
      holdAutosaveRef.current = false
      setInitialData(undefined)
      setElements([])
      setSelectedIds([])
      setPlaceholders([])
      placeFailuresRef.current = {}
      setSelectionCtx(null)
      exitEdit()
      sceneSigRef.current = ''
      selectionSigRef.current = ''
      latestSceneRef.current = null
      const canvas = await canvasesApi.get(targetId)
      // 快速连点：过期响应直接丢弃，最后一次点击说了算
      if (seq !== switchSeqRef.current) return
      setCanvas(canvas)
      setCanvasId(canvas.id)
      applyScene(canvas.state)
    },
    [autosave, applyScene, exitEdit, setCanvas, setAutosaveReady]
  )

  // 解析目标画布：一个会话 = 一块画布（新建会话即空画布，切换会话恢复各自画布）
  useEffect(() => {
    let active = true
    /** 项目兜底：取第一个项目，没有就建一个（首屏不能因为缺项目而空白） */
    const ensureProjectId = async (): Promise<string> => {
      const projects = await projectsApi.list({ size: 1 })
      if (projects.items.length > 0) {
        setProjectName(projects.items[0].name ?? '')
        return projects.items[0].id
      }
      const created = await projectsApi.create('我的第一个项目')
      setProjectName(created.name ?? '我的第一个项目')
      return created.id
    }
    const resolve = async () => {
      const seq = ++switchSeqRef.current
      const stale = () => !active || seq !== switchSeqRef.current
      try {
        // 1) 带会话：会话绑定哪块画布就加载哪块；没绑定就建一块空画布并绑定
        if (sessionId) {
          const session = await chatApi.getSession(sessionId)
          if (stale()) return
          if (session.canvas_id) {
            await switchCanvas(session.canvas_id)
            return
          }
          const projectId = await ensureProjectId()
          if (stale()) return
          const created = await projectsApi.createCanvas(projectId, '新对话')
          if (stale()) return
          await chatApi.bindCanvas(sessionId, created.id)
          if (stale()) return
          await switchCanvas(created.id)
          return
        }
        // 2) 显式指定画布（直达链接 / 分享页）
        if (initialCanvasId) {
          await switchCanvas(initialCanvasId)
          return
        }
        // 3) 无会话无画布：第一个项目的第一块画布，没有就建项目 + 画布
        const projectId = await ensureProjectId()
        if (stale()) return
        const canvases = await projectsApi.listCanvases(projectId)
        if (stale()) return
        if (canvases.length > 0) {
          await switchCanvas(canvases[0].id)
          return
        }
        const created = await projectsApi.createCanvas(projectId, '我的第一块画布')
        if (stale()) return
        await switchCanvas(created.id)
      } catch (error) {
        if (!active) return
        toast.error(errorMessage(error, te))
      }
    }
    void resolve()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, initialCanvasId])

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

  // 可用编辑能力清单（注册表驱动：管理员新增能力后此处自动生效，无需改前端）
  useEffect(() => {
    let active = true
    generateApi
      .capabilities()
      .then((res) => {
        if (!active) return
        setEditCapabilities(Array.isArray(res.handlers) ? res.handlers : [])
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
      // 只有内容真正变化才需要保存：Excalidraw 挂载 / 平移缩放也会触发 onChange，
      // 无条件 schedule 会让刚打开的空画布立刻显示「未保存的更改」。
      const sig = sceneSignature(nextElements)
      const hold = holdAutosaveRef.current
      if (sig !== sceneSigRef.current) {
        sceneSigRef.current = sig
        setElements(nextElements)
        // 加载刚完成的那一次「空场景」事件只同步 state，不写盘
        if (!(hold && nextElements.length === 0)) {
          holdAutosaveRef.current = false
          autosave.schedule(scene)
        }
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
      // 编辑目标被取消选中 → 退出编辑模式（同时清空选区上下文）
      const current = editTargetRef.current
      if (current && !nextElements.some((el) => el.id === current.elementId && selected[el.id])) {
        exitEdit()
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
    [autosave, exitEdit]
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

  /**
   * 补全画布图片对应的后端资产 id。
   *
   * 上传 / 素材插入的元素自带 `customData.assetId`；由结果、分享链接等途径进来的
   * 元素没有，需要把画布里的图回传到资产库一次，侧栏的需求分析才有图可看。
   * 同一元素只在第一次进入编辑时上传（`assetIdRef` 缓存），失败静默降级为空。
   */
  const ensureElementAsset = useCallback(
    async (instance: ExcalidrawApiLike | null, element: CanvasElement): Promise<string | undefined> => {
      const custom = (element.customData ?? {}) as Record<string, unknown>
      const inline = typeof custom.assetId === 'string' && custom.assetId ? custom.assetId : ''
      if (inline) {
        assetIdRef.current[element.id] = inline
        return inline
      }
      const cached = assetIdRef.current[element.id]
      if (cached) return cached
      const dataUrl = elementImageDataUrl(instance, element)
      if (!dataUrl) return undefined
      try {
        const response = await fetch(dataUrl)
        const blob = await response.blob()
        const file = new File([blob], 'canvas-image.png', { type: blob.type || 'image/png' })
        const asset = await assetsApi.upload(file)
        assetIdRef.current[element.id] = asset.id
        if (instance) {
          // 回写 customData：下次进入编辑、以及场景落库后都无需重复上传
          const nextElements = instance.getSceneElements().map((el) =>
            el.id === element.id
              ? {
                  ...el,
                  customData: {
                    ...((el.customData ?? {}) as Record<string, unknown>),
                    assetId: asset.id,
                  },
                }
              : el
          )
          instance.updateScene({ elements: nextElements })
          const appState = instance.getAppState() as { viewBackgroundColor?: unknown }
          const scene: CanvasState = {
            elements: nextElements,
            files: instance.getFiles(),
            appState: { viewBackgroundColor: appState.viewBackgroundColor },
          }
          latestSceneRef.current = scene
          autosave.schedule(scene)
        }
        return asset.id
      } catch {
        // 静默降级：拿不到资产不影响画布编辑本身
        return undefined
      }
    },
    [autosave]
  )

  /** 进入编辑模式（单击选中图片即触发）。 */
  const enterEdit = useCallback(
    async (element: CanvasElement) => {
      const instance = apiRef.current
      const dataUrl = elementImageDataUrl(instance, element)
      if (!dataUrl) {
        toast.error('该图片尚未加载完成，请稍后重试')
        return
      }
      try {
        const { w, h } = await probeSize(dataUrl)
        const presetPrompt = await resolvePresetPrompt(element)
        const assetId = await ensureElementAsset(instance, element)
        setEditPrompt(presetPrompt)
        setEditTarget({
          elementId: element.id,
          dataUrl,
          width: w,
          height: h,
          presetPrompt,
          assetId,
          // 键只在这里算一次：dataUrl 很大，别放进 render 路径
          draftKey: editDraftKey(element.id, dataUrl) ?? element.id,
        })
        setEditRect(elementScreenRect(apiRef.current, element))
      } catch {
        toast.error('图片载入失败，请重试')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast]
  )

  /**
   * 选区变化 → 组装上抛给侧栏的上下文。
   *
   * ⚠️ 这里的关键是 `regions.length > 0` 的判断：
   * 只要编辑层开着、哪怕一个区域都没框，也绝不能上抛上下文。
   * 否则侧栏会认为「这是一次区域编辑」，把用户那句本该走 compose 的话
   * 拐进 `/chat/analyze`——这正是「框选功能跑到对话里去了」的直接原因。
   * 空数组 = 没有选区 = 对话里那句话就是普通的生图需求。
   */
  const handleSelectionChange = useCallback(
    (info: {
      count: number
      revision: number
      hasDoodle: boolean
      regions: SelectionRegionContext[]
    }) => {
      const target = editTargetRef.current
      const regions = Array.isArray(info.regions) ? info.regions : []
      // 编辑层关闭、或没有任何区域 → 清空上下文，让侧栏走纯文本链路
      if (!target || regions.length === 0) {
        setSelectionCtx(null)
        return
      }
      setSelectionCtx({
        asset_id: target.assetId ?? null,
        target_id: target.elementId,
        revision: info.revision,
        width: target.width,
        height: target.height,
        has_doodle: info.hasDoodle,
        mask_asset_id: null,
        regions: regions.map((item) => ({
          index: item.index,
          region: item.region,
          path: item.path ?? null,
          prompt: item.prompt,
          handler: item.handler,
        })),
        // 侧栏发消息前调用，把并集掩码上传后回填 mask_asset_id
        buildMask: () => editLayerRef.current?.getMaskFile() ?? Promise.resolve(null),
      })
    },
    []
  )

  /**
   * 单击（无拖拽位移）选中图片 → 进入编辑模式，并把这张图作为 @ 引用送进输入框。
   *
   * 为什么点击就引用：本产品里「点中一张图」的意图几乎总是「我要在这张图上做事」，
   * 而输入框正是下指令的地方。把它带进输入框 = 省掉「先选中、再说明是哪张」这一句，
   * 也让后续指令天然带上底图。引用是可移除的 chip，不会静默改写提示词。
   *
   * ⚠️ 这里的判定**只看这一笔是不是拖拽**，不看当时是否已经存在选区：
   * 拖拽（框选）在 pointerup 时位移必然超过容差，本来就会被下面那条 early return 拦掉。
   * 旧实现另加了一道「有选区就整笔跳过」的判断，属于重复条件，而且会顺手吞掉
   * 「编辑层已开、用户又点了另一张图」这类本该走引用路径的点击。
   */
  const handlePointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    clickStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now() }
  }

  const handlePointerUpCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = clickStartRef.current
    clickStartRef.current = null
    if (!start) return
    // 移动超过容差 / 按住过久 = 画布操作（拖拽、框选、平移），绝不是「点中」
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_MOVE_TOLERANCE) return
    if (Date.now() - start.time > CLICK_MAX_MS) return
    // 点在编辑层自己的 UI 上（选区手柄、气泡、涂鸦工具）不算点图
    if (e.target instanceof Element && e.target.closest('[data-edit-layer-ui]')) return
    // 等 Excalidraw 完成选中态更新后再判断
    window.setTimeout(() => {
      const element = selectedImageRef.current
      if (!element) return
      void referenceCanvasImage(element)
      if (editTargetRef.current?.elementId === element.id) return
      void enterEdit(element)
    }, 0)
  }

  /**
   * 把画布上的一张图作为 @ 引用插进输入框。
   * 先补齐资产 id（没有的话回传一次资产库），这样引用在提交时能直接当底图用。
   */
  const referenceCanvasImage = useCallback(
    async (element: CanvasElement) => {
      const instance = apiRef.current
      const custom = (element.customData ?? {}) as Record<string, unknown>
      const inline = typeof custom.assetId === 'string' && custom.assetId ? custom.assetId : ''
      const dataUrl = elementImageDataUrl(instance, element) ?? ''
      const key = inline || element.id
      const preview = inline ? apiUrl(`/assets/${inline}`) : dataUrl
      // 引用装不下时（超过 4 张）给出明确反馈，而不是默默丢掉这一次点击
      const accepted = useComposerRefs
        .getState()
        .addRef({ key, url: preview, assetId: inline || undefined })
      if (!accepted) {
        toast.warning(t('input.ref_limit', { max: MAX_COMPOSER_REFS }), t('input.ref_limit_hint'))
        return
      }
      if (!inline) {
        // 没有资产 id：后台补登记一次，不阻塞这次点击（resolveMentionIds 也会兜底）
        void ensureElementAsset(instance, element)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast, ensureElementAsset]
  )

  // ESC：先收「打开的表面」（气泡 / 拖拽中的选区），都没有才退出编辑
  useEffect(() => {
    if (!editTarget) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 输入法组词中的 Esc 是取消候选词，不是关闭
      if (e.isComposing) return
      // 有弹层打开（如区域润色）：Esc 交给弹层自己关
      if (document.querySelector('[data-edit-surface="popover"]')) return
      const layer = editLayerRef.current
      if (layer?.hasOpenSurface()) {
        layer.collapseActiveSurface()
        return
      }
      exitEdit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editTarget, exitEdit])

  // 选中图片变化时同步右栏预览（dataUrl + 原图尺寸）
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
        if (alive) setSelectedImageInfo({ dataUrl, width: w, height: h })
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

  const insertAsset = async (asset: Asset) => {
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
      let created: CanvasElement | null = null
      if (api) {
        created = await addImageToCanvas(api, {
          url: asset.url,
          assetId: asset.id,
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 20) || '上传图片',
          width: asset.width,
          height: asset.height,
        })
      }
      // 上传后只同步平台侧选中态（图层高亮）：画布上的图一多，用户得自己找哪张是刚传的。
      // 不回写 Excalidraw 的 selectedElementIds —— 那会和「单击即进入编辑」的判定互相打架。
      if (created) {
        selectionSigRef.current = created.id
        setSelectedIds([created.id])
        selectedImageRef.current = created
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
    // 图没了，草稿也没必要留着（按元素 id 前缀清，不需要 dataUrl）
    clearEditDraftsForElement(id)
    // 用含 isDeleted 的完整列表重建：只过滤可见元素会让被删的元素仍留在场景里，
    // 一次 Ctrl+Z 就会把刚删的图全部复活
    api.updateScene({
      elements: allSceneElements(api).map((el) =>
        el.id === id ? { ...el, isDeleted: true } : el
      ),
    })
  }

  const handleDeleteSelected = () => {
    if (!api) return
    const appState = api.getAppState() as { selectedElementIds?: Record<string, boolean> }
    const selected = appState.selectedElementIds ?? {}
    // 被删掉的正是正在编辑的图 → 先退出编辑，避免侧栏留着已不存在的选区
    if (editTargetRef.current && selected[editTargetRef.current.elementId]) exitEdit()
    for (const id of Object.keys(selected)) {
      if (selected[id]) clearEditDraftsForElement(id)
    }
    api.updateScene({
      elements: allSceneElements(api).map((el) => (selected[el.id] ? { ...el, isDeleted: true } : el)),
    })
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

  const handleSessionChange = (id: string) => {
    void navigate({ to: '/workspace', search: { session: id, task: taskId } as never, replace: true })
  }

  /** 新建对话（左栏入口）：新对话 = 新画布，避免上一轮的图还留在画布上。 */
  const handleCreateSession = async () => {
    try {
      const created = await chatApi.createSession({ new_canvas: true })
      void navigate({ to: '/workspace', search: { session: created.id } as never, replace: true })
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  /** 删除对话：删的是当前这条时，自动切到最近的一条，切不到就回到空白工作台。 */
  const handleDeleteSession = async (id: string) => {
    await chatApi.deleteSession(id)
    if (id !== sessionId) return
    const rest = await chatApi.listSessions().catch(() => [] as Awaited<ReturnType<typeof chatApi.listSessions>>)
    const next = rest.find((item) => item.id !== id)
    void navigate({
      to: '/workspace',
      search: (next ? { session: next.id } : {}) as never,
      replace: true,
    })
  }

  /**
   * 图片落入画布：把元素设成选中态。
   *
   * Excalidraw 的场景元素画在 canvas 上，无法直接跑 CSS/GSAP 动画；
   * 强行给 SVG 层加过渡会和它的内部坐标系打架。这里只做"落地即选中"，
   * 让新图立刻带选框并进入可编辑状态——这是最贴合用户预期的反馈。
   */
  const dropIn = (elementId: string) => {
    apiRef.current?.updateScene({
      appState: { selectedElementIds: { [elementId]: true } },
    })
  }

  /**
   * 手动「放入画布」：用户点一次就必须有结果——要么放上去，要么说清为什么没放。
   *
   * 之前这里有两次静默 return（画布还没就绪、以及「url 已登记但场景里其实没有」时
   * 被判成已放置），用户看到的就是「点了没反应、这张图再也放不进画布」。
   * 现在只有「场景里确实已经有同一张图」才会拦，并且给明确反馈 + 把那张图带到眼前。
   */
  const handleAddResultToCanvas = async (url: string, taskIdInner: string) => {
    const instance = apiRef.current ?? api
    if (!instance) {
      toast.error('画布还在加载中，请稍后再试')
      return
    }
    if (sceneSourceUrls(instance)?.has(url)) {
      const existing = instance
        .getSceneElements()
        .find(
          (el) =>
            el.type === 'image' &&
            (el.customData as { sourceUrl?: unknown } | undefined)?.sourceUrl === url
        )
      if (existing) {
        focusSceneBox(instance, {
          x: existing.x ?? 0,
          y: existing.y ?? 0,
          w: existing.width ?? RESULT_MAX_SIDE,
          h: existing.height ?? RESULT_MAX_SIDE,
        })
        dropIn(existing.id)
      }
      toast.info('这张图片已经在画布上了')
      return
    }
    try {
      // 落点先找空位：直接放视口中心会盖住用户正在看的图
      const spot = findEmptySpot(instance, RESULT_MAX_SIDE, RESULT_MAX_SIDE)
      const created = await addImageToCanvas(instance, {
        url,
        assetId: await materializeResultAsset(url),
        width: RESULT_MAX_SIDE,
        height: RESULT_MAX_SIDE,
        x: spot.x,
        y: spot.y,
      })
      markUrlPlaced(url, canvasId)
      markTaskPlaced(taskIdInner, canvasId)
      dropIn(created.id)
      focusSceneBox(instance, {
        x: created.x ?? spot.x,
        y: created.y ?? spot.y,
        w: created.width ?? RESULT_MAX_SIDE,
        h: created.height ?? RESULT_MAX_SIDE,
      })
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  /**
   * 对话里的结果到达 → 自动落画布并平滑聚焦（静默：不弹任何提示）。
   *
   * 去重、找空位、聚焦都在这里收口，对话面板只负责「结果来了」：
   * - url 已登记且场景里确实还在 → 跳过；
   * - 登记了但场景里已经没有（用户删了 / 换了设备）→ 补回去。
   */
  const lastAutoPlaceKeyRef = useRef('')
  const autoPlaceResults = useCallback(
    async (urls: string[], taskKey: string) => {
      const instance = apiRef.current
      if (!instance || urls.length === 0) return
      const fresh = unplacedResultUrls(instance, urls, loadPlacedUrls(canvasId))
      if (fresh.length === 0) return
      const key = `${taskKey}::${fresh.join(',')}`
      if (key === lastAutoPlaceKeyRef.current) return
      lastAutoPlaceKeyRef.current = key
      try {
        const created = await placeResultSet(instance, fresh, 'AI 生成结果', canvasId)
        markTaskPlaced(taskKey, canvasId)
        focusSceneBox(instance, unionBox(created))
      } catch {
        // 自动路径失败不打扰用户，手动「放入画布」仍可用
        lastAutoPlaceKeyRef.current = ''
      }
    },
    [canvasId]
  )

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
            // 逐张投放全部产出：多产出任务（1 张修改图 + N 张素材）只投第一张会丢结果。
            // 落图失败（多为结果图临时链接已失效）单独处理：计数重试，超阈值就收掉
            // 骨架并如实告知——否则会在画布上永远留一块「生成中…」的假象。
            let placed = 0
            try {
              placed = await placeTaskResults(api, task, { x: ph.sceneX, y: ph.sceneY }, canvasId)
            } catch {
              const attempts = (placeFailuresRef.current[ph.taskId] ?? 0) + 1
              placeFailuresRef.current[ph.taskId] = attempts
              if (attempts < 6) continue
              delete placeFailuresRef.current[ph.taskId]
              setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
              toast.error(
                t('region.gen_place_failed', {
                  defaultValue: '结果图加载失败，请稍后在对话里重新放入画布',
                })
              )
              continue
            }
            delete placeFailuresRef.current[ph.taskId]
            markTaskPlaced(task.id, canvasId)
            setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
            // 编辑结果落在原图旁边：镜头推过去，小图上改的细节才看得见
            focusSceneBox(api, {
              x: ph.sceneX,
              y: ph.sceneY,
              w: ph.sceneW,
              h: ph.sceneH,
            })
            if (placed > 0) {
              toast.success(
                t('region.generated', { defaultValue: '生成完成，结果已放到画布' }),
                task.result_urls.length > 1 ? `共 ${task.result_urls.length} 张结果` : undefined
              )
            }
          } else if (task.status === 'failed' || task.status === 'timeout' || task.status === 'cancelled') {
            delete placeFailuresRef.current[ph.taskId]
            setPlaceholders((prev) => prev.filter((item) => item.taskId !== ph.taskId))
            // 只显示用户能看懂的结果，不透传后端错误详情
            toast.error(t('region.gen_failed', { defaultValue: '生成未完成，额度已退回' }))
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

  /** 编辑确认：把「带框选标记的图 + 结构化操作」提交执行（能力注册表驱动）。 */
  const handleEditSubmit = async (payload: {
    baseFile: File
    maskFile: File | null
    guideFile: File | null
    regions: NormRegion[]
    ops: EditOpPayload[]
    prompt: string
  }) => {
    const target = editTargetRef.current
    if (!target) return
    // 所有编辑操作（含抠图 / 透明化）都调用上游 gpt-image-2，必须校验并扣减额度
    if (!canAfford(prices.edit)) {
      setQuotaModalOpen(true)
      return
    }

    setEditSubmitting(true)
    try {
      const task = await generateApi.edit(
        {
          prompt: payload.prompt,
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file: payload.baseFile,
          mask: payload.maskFile ?? undefined,
          guide: payload.guideFile ?? undefined,
          region: payload.regions,
          ops: payload.ops.length > 0 ? payload.ops : undefined,
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
      // 任务已建：这张图的草稿使命完成，必须清掉——
      // 否则用户再点回原图会看到「已经提交过的那一版选区」又冒出来
      clearEditDraft(target.draftKey)
      exitEdit()
      events.emit('tasks:changed')
      events.emit('quota:changed')
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setEditSubmitting(false)
    }
  }

  return (
    <div ref={shellRef} className="flex h-full min-h-0 flex-col overflow-hidden">
      <MobileSegmented />
      <div className="flex min-h-0 flex-1 gap-2.5 p-2.5">
        {/* 左：我的工作室（历史对话 / 参考图 / 作品）。固定列，不随画布滚动 */}
        <div data-panel className="hidden min-h-0 shrink-0 flex-col gap-1.5 md:flex">
          <StudioSidebar
            currentSessionId={sessionId || null}
            onSelectSession={handleSessionChange}
            onCreateSession={() => void handleCreateSession()}
            onDeleteSession={handleDeleteSession}
            onUseAsset={(asset) => void insertAsset(asset)}
            onUseWork={(url, id) => void handleAddResultToCanvas(url, id)}
            onUpload={() => uploadInputRef.current?.click()}
          />
          {/* 页面左下角：消息 + 额度 + 账号（小尺寸、上下布局），与左栏同宽贴底 */}
          <WorkspaceIdentityBar />
        </div>

        {/* 中：画布（页面主体） */}
        <div
          data-panel
          className={cn(
            // min-h-0 必填：缺了它，画布列的内容高度会把整行撑出视口
            'min-w-0 flex-1 flex-col gap-1.5',
            mobileSegment === 'canvas' ? 'flex min-h-0' : 'hidden md:flex md:min-h-0'
          )}
        >
          <div className="relative shrink-0 px-1">
            <CanvasHeader
              canvasId={canvasId}
              api={api}
              hasImageSelected={hasImageSelected}
              className="pr-1"
            />
          </div>
          <div
            className={cn(
              // 画布做成浮起的纸卡：留出外边距 + 软角 + 暖灰阴影，
              // 底色用 --color-canvas（比纸底深一档），让图片浮起来；
              // 不靠 1px 描边定义边界——层级靠明度差 + 阴影表达
              'cs-canvas-card relative min-h-0 flex-1 overflow-hidden rounded-[16px] bg-canvas shadow-sheet',
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
                key={canvasId ?? 'blank'}
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
            <CanvasToolbar
              api={api}
              onAddImage={openAssetPicker}
              onUpload={() => uploadInputRef.current?.click()}
              onDeleteSelected={handleDeleteSelected}
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
                    if (element.type === 'image' && editTargetRef.current?.elementId !== element.id) {
                      void enterEdit(element)
                    }
                  }}
                  collapsed={false}
                />
              }
            />
            {placeholders.map((ph) => (
              <div
                key={ph.taskId}
                className="pointer-events-none absolute z-10 flex items-center justify-center overflow-hidden rounded-lg border border-accent-strong/50 bg-surface/80"
                style={{ left: ph.screenX, top: ph.screenY, width: ph.screenW, height: ph.screenH }}
              >
                {/* 生成中的骨架：青柠光带扫过，表示 AI 正在动作 */}
                <span aria-hidden className="cs-shimmer absolute inset-0" />
                <div className="relative flex flex-col items-center gap-2 text-text-secondary">
                  <Loader2 size={20} className="animate-spin text-accent-ink" />
                  <span className="text-xs">{t('region.generating', { defaultValue: '生成中…' })}</span>
                </div>
              </div>
            ))}

            {/* 全局缩略图：固定在左下角，主画布拖远/缩小时用它找回内容 */}
            {api && <CanvasMinimap api={api} />}

            {/* 选中图片的浮动预览：贴在画布右下角（左下角让给全局缩略图） */}
            {selectedImageInfo?.dataUrl && (
              <div className="absolute bottom-[60px] right-3 z-20 w-[214px] rounded-[14px] bg-surface/95 p-2 shadow-float ring-1 ring-inset ring-border-faint backdrop-blur-md">
                <ImagePreviewPanel
                  imageUrl={selectedImageInfo.dataUrl}
                  width={selectedImageInfo.width}
                  height={selectedImageInfo.height}
                  onEdit={() => {
                    if (selectedImage) void enterEdit(selectedImage)
                  }}
                  onDownload={(format) => void handleDownloadSelected(format)}
                  onDelete={() => {
                    if (selectedImage) handleDeleteElement(selectedImage.id)
                  }}
                />
              </div>
            )}

            {/* 编辑层：单击图片即进入，精确贴合原图位置 */}
            <ImageEditLayer
              ref={editLayerRef}
              open={!!editTarget}
              dataUrl={editTarget?.dataUrl ?? ''}
              draftKey={editTarget?.draftKey ?? null}
              naturalWidth={editTarget?.width ?? 1}
              naturalHeight={editTarget?.height ?? 1}
              imgRect={editRect}
              submitting={editSubmitting}
              prompt={editPrompt}
              onPromptChange={setEditPrompt}
              promptTemplate={promptTemplate}
              presets={presets}
              handlers={editCapabilities}
              onClose={exitEdit}
              onSubmit={(payload) => void handleEditSubmit(payload)}
              onGoCreate={({ prompt }) => {
                // 图片 + 需求一起交给右侧对话面板：由它做 AI 分析再出图
                const target = editTarget
                if (!target) return
                void (async () => {
                  try {
                    const blob = await (await fetch(target.dataUrl)).blob()
                    const file = new File([blob], 'canvas-selection.png', { type: blob.type || 'image/png' })
                    exitEdit()
                    useComposerHandoff.getState().stage(prompt, [file])
                  } catch (error) {
                    toast.error('没能把选区送到对话', errorMessage(error, te))
                  }
                })()
              }}
              onSelectionChange={handleSelectionChange}
              onDelete={() => {
                const id = editTargetRef.current?.elementId
                if (id) handleDeleteElement(id)
              }}
              onError={(message) => toast.error(message)}
              onNotice={(message) => toast.success(message)}
            />
          </div>
        </div>

        {/* 右：对话（唯一的实例：靠 CSS 控制移动端/桌面端形态，避免双份轮询） */}
        <div
          data-panel
          className={cn(
            'min-h-0 overflow-hidden rounded-[16px] bg-surface shadow-sheet',
            mobileSegment === 'chat'
              ? 'flex flex-1 flex-col md:w-[400px] md:flex-none'
              : 'hidden md:flex md:w-[400px] md:shrink-0 md:flex-col'
          )}
        >
          <ChatPanel
            canvasId={canvasId ?? undefined}
            sessionId={sessionId || null}
            selection={selectionCtx}
            onFocusCanvas={() => useUIStore.getState().setMobileSegment('canvas')}
            onSessionChange={handleSessionChange}
            onAddResultToCanvas={handleAddResultToCanvas}
            onResultsReady={autoPlaceResults}
            onUpload={() => uploadInputRef.current?.click()}
            onPickAsset={openAssetPicker}
            initialPrompt={initialPrompt}
            initialFiles={initialFiles}
            onInitialConsumed={() => {
              setInitialPrompt(null)
              setInitialFiles([])
            }}
          />
        </div>
      </div>

      <Modal
        open={assetPickerOpen}
        onOpenChange={setAssetPickerOpen}
        title={t('assets:title', { defaultValue: '选择素材' })}
        size="lg"
      >
        <div className="max-h-[60vh] overflow-y-auto">
          <AssetGrid assets={pickerAssets} onUse={insertAsset} />
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
