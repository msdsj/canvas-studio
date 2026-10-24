import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import { CanvasExcali } from './CanvasExcali'
import { ScrollTrigger } from '@/lib/gsap'
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
import { CanvasNavigator } from './stage/CanvasNavigator'
import { CollabPanel, CommentPins, type CollabTab } from './collab/CollabPanel'
import { RemoteCursors } from './collab/RemoteCursors'
import { useCanvasComments } from './collab/useCanvasComments'
import { GeneratingCard } from './stage/GeneratingCard'
import { RevealLayer, type RevealLayerHandle } from './stage/RevealLayer'
import { CanvasDropZone } from './stage/CanvasDropZone'
import { EmptyCanvas } from './stage/EmptyCanvas'
import { useCanvasHistory } from './stage/use-canvas-history'
import { focusAgentComposer } from './stage/composer-bridge'
import { ImageActionBar } from './stage/ImageActionBar'
import { CompareDialog } from './stage/CompareDialog'
import {
  findParent,
  readLineage,
  versionOf,
  withLineage,
  type Lineage,
  type LineageOp,
} from './stage/lineage'
import './stage/stage.css'
import { StudioSidebar } from '@/components/studio/StudioSidebar'
import { AgentPanelHeader, CanvasTopBar } from '@/components/workspace/WorkspaceChrome'
import { usePanelMotion } from '@/components/workspace/use-panel-motion'
import {
  addImageToCanvas,
  allSceneElements,
  downloadImageAs,
  imageToBlob,
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
import { useAuth } from '@/hooks/use-auth'
import { useTeamScopeKey } from '@/hooks/use-team-scope'
import { useCanvasAutosave } from './useCanvasAutosave'
import { useCanvasCollabScene } from './useCanvasCollabScene'
import { CollabPresence } from './CollabPresence'
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
import { useAuthStore } from '@/stores/auth'
import { addPromptHistory } from '@/lib/prompt-history'
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

/** 编辑目标：进入框选修改的那张图片。 */
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

/** 整张图作为一个选区（归一化坐标）：一键操作作用于全图 */
const FULL_IMAGE_REGION = { x: 0, y: 0, w: 1, h: 1 }

/**
 * 一键操作交给图像模型的指令（模型侧文本，不是界面文案，所以不走 i18n）。
 * 后端能力注册表里 enhance / cutout 各自还有一段强约束前缀，这里只补「对象是整张图」。
 */
const QUICK_OP_PROMPT: Record<'enhance' | 'cutout', string> = {
  enhance: '对整张图片做高清增强：提升清晰度、细节与质感，构图、内容、配色与风格保持完全一致。',
  cutout: '把画面的主体完整分离出来，输出透明背景的 PNG 素材，主体本身保持与原图完全一致。',
}

/** 结果默认以较小的画布尺寸呈现，保留足够的空白用于并排比较与继续创作。 */
const RESULT_MAX_SIDE = 200
const RESULT_GAP = 28

/** 所有落图入口共享同一尺寸策略，保持原始宽高比，避免窄图被最小边长拉伸。 */
function resultDisplaySize(size: { width: number; height: number }): { width: number; height: number } {
  const sourceWidth = Number.isFinite(size.width) && size.width > 0 ? size.width : RESULT_MAX_SIDE
  const sourceHeight = Number.isFinite(size.height) && size.height > 0 ? size.height : RESULT_MAX_SIDE
  const scale = Math.min(1, RESULT_MAX_SIDE / Math.max(sourceWidth, sourceHeight))
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  }
}

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
  canvasId?: string | null,
  lineage?: Lineage
): Promise<number> {
  // 逐张去重：一次任务可能产出「1 张整图 + N 张素材」。若中途某张拉取失败，
  // 下一轮轮询会重来——不按 url 去重就会把已经落过的图重复叠到画布上。
  const todo = unplacedResultUrls(api, task.result_urls, loadPlacedUrls(canvasId))
  let cursorX = origin.x
  for (const url of todo) {
    const size = await imageSize(url)
    const { width, height } = resultDisplaySize(size)
    const element = await addImageToCanvas(api, {
      url,
      assetId: await materializeResultAsset(url),
      name: task.prompt.slice(0, 20),
      width,
      height,
      x: cursorX,
      y: origin.y,
    })
    // 记下「这张是从哪张改出来的」：版本号与前后对比都靠它
    if (lineage) {
      api.updateScene({
        elements: api
          .getSceneElements()
          .map((el) => (el.id === element.id ? withLineage(el as CanvasElement, lineage) : el)),
      })
    }
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
    const { width, height } = resultDisplaySize(size)
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
  const { user } = useAuth()
  const { resolved } = useTheme()
  const { canAfford, prices } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)

  const setCanvas = useCanvasStore((s) => s.setCanvas)
  const setProjectName = useCanvasStore((s) => s.setProjectName)
  // 选中态同步到 store：CanvasHeader 的「导出」据此高亮，避免两处各算一套
  const setStoreSelectedIds = useCanvasStore((s) => s.setSelectedElementIds)
  const mobileSegment = useUIStore((s) => s.mobileSegment)
  const agentPanelOpen = useUIStore((s) => s.agentPanelOpen)
  const studioDrawerOpen = useUIStore((s) => s.studioDrawerOpen)
  const closeStudioDrawer = useUIStore((s) => s.closeStudioDrawer)
  const agentPanelRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  /*
   * 工作台不需要 ScrollTrigger：这里的动画全是补间/时间线，没有一个滚动触发器。
   * 但 `@/lib/gsap` 会全局注册插件，聊天卡片一 import 就把它带进来了，
   * 于是 ScrollTrigger 在「0 个实例」的情况下仍然 60fps 空转
   * （实测占页面自请求帧的一半：124/s → 60/s）。
   * 进工作台关掉、离开时恢复，主页的滚动动画不受影响。
   */
  useEffect(() => {
    ScrollTrigger.disable(false, true)
    return () => {
      ScrollTrigger.enable()
    }
  }, [])

  // Agent 面板：≥md 推挤收放；移动端由「画布 / 对话」分段切换接管
  usePanelMotion(agentPanelRef, agentPanelOpen, { pushQuery: '(min-width: 768px)' })
  // 工作室抽屉：≥lg 推挤画布；更窄时从左侧滑出、盖在内容之上
  usePanelMotion(drawerRef, studioDrawerOpen, {
    pushQuery: '(min-width: 1024px)',
    overlayBelow: true,
  })

  // 浮层形态的抽屉支持 Esc 关闭（推挤形态不抢 Esc：那是画布取消选择的键）
  useEffect(() => {
    if (!studioDrawerOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (window.matchMedia('(min-width: 1024px)').matches) return
      closeStudioDrawer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [studioDrawerOpen, closeStudioDrawer])

  const shellRef = useRef<HTMLDivElement>(null)
  /** 首页交接下来的一句话 + 参考图：交给右侧对话面板自动提交（只消费一次） */
  const [initialPrompt, setInitialPrompt] = useState<string | null>(null)
  const [initialFiles, setInitialFiles] = useState<File[]>([])
  const handoffRef = useRef(false)

  const [canvasId, setCanvasId] = useState<string | null>(initialCanvasId ?? null)
  /** 场景是否已经灌进 Excalidraw（协作要等这个为真再连，否则快照会冲掉本地状态） */
  const [sceneReady, setSceneReady] = useState(false)
  /** 当前画布的元信息（team_id 决定是否启用协作） */
  const canvasMetaRef = useRef<{ team_id?: string | null } | null>(null)
  /** 全量重拉场景：协作检测到版本落后时调用 */
  const reloadSceneRef = useRef<() => Promise<void>>(async () => {})
  /** 协作 diff 基线重置（applyScene 里调用；hook 在下面才初始化，故用 ref 中转） */
  const collabResetBaselineRef = useRef<(elements: CanvasElement[]) => void>(() => {})
  /**
   * 协作上行与在线态也走 ref。
   *
   * 不能放进 `handleChange` 的依赖数组：在线人数（presence）每次变动都会让
   * 那个对象换新，于是 onChange 每帧重建并一路传进 Excalidraw——
   * 结果是「有人进来」这种与编辑无关的事件也会让正在拖拽的画布掉帧。
   */
  const collabPushRef = useRef<(elements: CanvasElement[]) => boolean>(() => false)
  const collabLiveRef = useRef(false)
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | undefined>(undefined)
  const [api, setApi] = useState<ExcalidrawApiLike | null>(null)
  const [elements, setElements] = useState<CanvasElement[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  /** 上抛给侧栏「需求分析中转站」的选区上下文；没有编辑目标时为 null */
  const [selectionCtx, setSelectionCtx] = useState<CanvasSelectionContext | null>(null)

  // 编辑模式（单击选中图片即进入）
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null)
  /** 画布纸卡：拖放区监听、撤销/重做找原生按钮都以它为根 */
  const canvasCardRef = useRef<HTMLDivElement>(null)
  /** 结果落画布的「显影」动效层 */
  const revealRef = useRef<RevealLayerHandle>(null)
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
      /** 提交时间：占位卡据此显示用时、估算阶段、判断是否超时 */
      startedAt: number
      /** 来源图与改法：结果落图时写进 customData，形成版本谱系 */
      lineage?: Lineage
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

  /*
   * 实时协作。
   *
   * `enabled` 只对「有团队归属」的画布为真：个人画布连一个常驻 WebSocket
   * 纯属浪费连接，而且不会有第二个人进来。
   *
   * 协作不可用（后端没开 WS / 网络受限）时自动落到 `offline`，此时 `isLive`
   * 为 false，整场景自动保存照旧生效——画布不会因为协作挂了而存不了。
   */
  const collabScene = useCanvasCollabScene({
    canvasId,
    enabled: Boolean(canvasMetaRef.current?.team_id),
    ready: sceneReady,
    api,
    onRemoteFullSync: () => {
      // 版本落后太多 / 服务端重启：重拉一次整份场景
      void reloadSceneRef.current()
    },
  })
  collabResetBaselineRef.current = collabScene.resetBaseline
  collabPushRef.current = collabScene.pushLocal
  collabLiveRef.current = collabScene.isLive

  /*
   * 开发态把画布句柄挂到 window 上。
   *
   * 协作链路的验收只能在真浏览器里做（要真连 WS、真要一次 onChange），
   * 而 Excalidraw 的场景在 canvas 里、DOM 上读不出来。有了这个钩子，
   * `scripts/ui_smoke_collab_two_tabs.py` 才能问「你现在有几个元素」。
   * `import.meta.env.DEV` 为 false 时整段被摇掉，不进生产包。
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__csCanvas = {
      get api() {
        return apiRef.current
      },
      get collab() {
        return {
          status: collabScene.status,
          version: collabScene.version,
          participants: collabScene.participants,
        }
      },
      elementIds: () =>
        (apiRef.current?.getSceneElements() ?? []).map((element) => element.id),
    }
  }, [collabScene.status, collabScene.version, collabScene.participants])
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
   * 入场：两块面板依次落位（Agent 对话 → 画布）。
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

  /** 场景里真正可见的元素数（空画布引导据此出现 / 消失） */
  const visibleCount = useMemo(
    () => elements.filter((el) => !(el as { isDeleted?: boolean }).isDeleted).length,
    [elements]
  )

  const history = useCanvasHistory(canvasCardRef, Boolean(api))

  /** 至少选中了一张图片：只有这时「导出」才可用（导出的是选中的图，不是整块画布） */
  const hasImageSelected = useMemo(
    () => elements.some((el) => el.type === 'image' && selectedIds.includes(el.id)),
    [elements, selectedIds]
  )

  useEffect(() => {
    setStoreSelectedIds(selectedIds)
  }, [selectedIds, setStoreSelectedIds])

  /** 视口版本号：平移 / 缩放时自增（rAF 节流），驱动操作条跟随 */
  const [viewTick, setViewTick] = useState(0)
  const viewTickRaf = useRef(0)
  /** 上一次驱动 viewTick 的「视口 + 选中图片几何」签名：没变就不重渲染工作台 */
  const viewSigRef = useRef('')
  /** 正在拖动 / 缩放 / 旋转元素：此时操作条让开，免得挡住手上的动作 */
  const [interacting, setInteracting] = useState(false)
  /** 正在提交的一键操作（按钮转圈，防连点重复扣费） */
  const [quickBusy, setQuickBusy] = useState<LineageOp | null>(null)
  /** 正在把选中图片收进素材库 */
  const [addingToLibrary, setAddingToLibrary] = useState(false)
  /** 协作面板（评论 / 版本）与打点态 */
  const [collabOpen, setCollabOpen] = useState(false)
  const [collabTab, setCollabTab] = useState<CollabTab>('comments')
  const [placingComment, setPlacingComment] = useState(false)
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  /** 刚打下、还没写内容的评论点 */
  const [draftPin, setDraftPin] = useState<{ x: number; y: number } | null>(null)
  /** 画布视口：评论点按它换算到屏幕坐标 */
  const [viewport, setViewport] = useState({ zoom: 1, scrollX: 0, scrollY: 0 })
  const commentState = useCanvasComments(canvasId)

  // --------------------------------------------------------------------- //
  // 在线状态：光标 + 视口（「跟随协作者视角」靠后者）
  // --------------------------------------------------------------------- //
  const presenceRef = useRef(collabScene.sendPresence)
  presenceRef.current = collabScene.sendPresence
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const presenceTickRef = useRef(0)
  const cursorTickRef = useRef(0)
  /** 正在跟随的协作者（null = 自由浏览） */
  const [followingId, setFollowingId] = useState<string | null>(null)

  // 视口变化：350ms 节流上报，避免拖拽时每帧一发
  useEffect(() => {
    if (collabScene.status !== 'online') return
    const now = Date.now()
    if (now - presenceTickRef.current < 350) return
    presenceTickRef.current = now
    presenceRef.current(null, undefined, viewport)
  }, [viewport, collabScene.status])

  /** 鼠标在画布上移动：把屏幕坐标换成场景坐标广播出去（100ms 节流）。 */
  const handlePresenceMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (collabScene.status !== 'online') return
    const now = Date.now()
    if (now - cursorTickRef.current < 100) return
    cursorTickRef.current = now
    const rect = event.currentTarget.getBoundingClientRect()
    const view = viewportRef.current
    presenceRef.current(
      {
        x: (event.clientX - rect.left) / view.zoom - view.scrollX,
        y: (event.clientY - rect.top) / view.zoom - view.scrollY,
      },
      undefined,
      view
    )
  }, [collabScene.status])

  /**
   * 跟随协作者：把对方的视口写进本地 appState。
   * 对方每次 presence 更新都会触发这里，于是「跟随」是真的实时跟随，
   * 而不是只在点的那一刻跳过去。
   */
  useEffect(() => {
    if (!followingId || !api) return
    const target = collabScene.participants.find((item) => item.id === followingId)
    if (!target) {
      setFollowingId(null)
      return
    }
    if (!target.viewport) return
    try {
      api.updateScene({
        appState: {
          scrollX: target.viewport.scrollX,
          scrollY: target.viewport.scrollY,
          zoom: { value: target.viewport.zoom },
        },
      })
    } catch {
      /* 对方视口不可用时保持原位 */
    }
  }, [followingId, collabScene.participants, api])

  /** 版本对比：两张图的 dataUrl 与版本号 */
  const [compare, setCompare] = useState<{
    before: { url: string; version: number }
    after: { url: string; version: number }
    op: LineageOp
  } | null>(null)
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
    setSceneReady(true)
    // 协作 diff 的基线必须跟着场景走，否则第一次 onChange 会被算成「全量新增」
    collabResetBaselineRef.current(scene.elements)
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
  /**
   * 全量重拉当前画布的场景。
   *
   * 只用于协作「版本落后太多」时的重同步：此时本地的增量已经接不上了，
   * 唯一安全做法是拉一份完整的回来。刻意不复用 `switchCanvas`——
   * 那条路径会清空 initialData 并重建 Excalidraw（撤销栈全丢），
   * 而这里只是把元素换掉，用户的撤销历史还在。
   */
  const reloadScene = useCallback(async () => {
    if (!canvasId) return
    try {
      const fresh = await canvasesApi.get(canvasId)
      const scene = normalizeScene(fresh.state)
      latestSceneRef.current = scene
      sceneSigRef.current = sceneSignature(scene.elements)
      setElements(scene.elements)
      collabResetBaselineRef.current(scene.elements)
      // 抑制这次 updateScene 触发的 onChange，否则刚拉回来的内容会被当成新改动再发一遍
      const instance = apiRef.current
      if (instance) {
        instance.updateScene({ elements: scene.elements })
      } else {
        setInitialData(scene as unknown as ExcalidrawInitialDataState)
      }
    } catch {
      // 重同步失败不致命：下一次 patch 还会再触发一次重试
    }
  }, [canvasId])
  reloadSceneRef.current = reloadScene

  const switchCanvas = useCallback(
    async (targetId: string) => {
      const seq = ++switchSeqRef.current
      await autosave.flush()
      autosave.cancel()
      // 新场景尚未到达：关闸，避免 Excalidraw 重建时的空场景把新画布写成空
      setAutosaveReady(false)
      holdAutosaveRef.current = false
      setInitialData(undefined)
      setSceneReady(false)
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
      canvasMetaRef.current = canvas as unknown as { team_id?: string | null }
      setCanvasId(canvas.id)
      applyScene(canvas.state)
    },
    [autosave, applyScene, exitEdit, setCanvas, setAutosaveReady]
  )

  /*
   * 切换工作空间后重新解析画布。
   *
   * 用 `spaceEpoch` 递增来驱动上面那段 `resolve`，而不是 `navigate`：
   * 用户在 `/workspace`（URL 里没有画布 id）时导航到同一路由是空操作，
   * 组件不会重挂载，画布也就不会刷新——他会继续看着上一个空间的内容编辑，
   * 而保存时可能撞 403。递增一个 epoch 则与路由无关，一定生效。
   *
   * 只在「当前画布不属于新空间」时才重解析：同一空间内切换（比如只是改了团队名）
   * 不该把用户正在编辑的画布换掉。
   */
  const scopeKey = useTeamScopeKey()
  const [spaceEpoch, setSpaceEpoch] = useState(0)
  useEffect(() => {
    const canvasTeam = canvasMetaRef.current?.team_id ?? null
    const wantTeam = scopeKey === 'personal' ? null : scopeKey
    if (canvasTeam === wantTeam) return
    // 首屏解析还没完成时不要打断它
    if (!canvasMetaRef.current) return
    setSpaceEpoch((prev) => prev + 1)
  }, [scopeKey])

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
  }, [sessionId, initialCanvasId, spaceEpoch])


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
      // 评论点 / 打点坐标都依赖视口：平移缩放时顺手同步一次（只在真的变了才 setState）
      const zoomState = appState.zoom as { value?: number } | number | undefined
      const nextZoom = Number(typeof zoomState === 'object' ? zoomState?.value : zoomState) || 1
      const nextScrollX = Number(appState.scrollX || 0)
      const nextScrollY = Number(appState.scrollY || 0)
      setViewport((prev) =>
        prev.zoom === nextZoom && prev.scrollX === nextScrollX && prev.scrollY === nextScrollY
          ? prev
          : { zoom: nextZoom, scrollX: nextScrollX, scrollY: nextScrollY }
      )
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
          /*
           * 先走协作增量通道；连不上时返回 false，再退回整场景自动保存。
           * 这个顺序不能反：协作在跑的时候若还整份覆盖写盘，
           * 会把同事刚合进来的元素一起抹掉。
           */
          const sent = collabPushRef.current(nextElements)
          if (!sent && !collabLiveRef.current) autosave.schedule(scene)
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

      const busy = Boolean(
        appState.selectedElementsAreBeingDragged || appState.isResizing || appState.isRotating
      )
      setInteracting((prev) => (prev === busy ? prev : busy))
      /*
       * 只有视口或选中图片的几何真的变了才推进 viewTick。
       *
       * ⚠️ 归因修正（2026-10 实测）：这里原本写着「旧版静止时也在空转、
       * 整个工作台重渲染」，实测**不成立**。选中一张图后 Excalidraw 的 onChange
       * 本身就以 ~59 次/秒 触发（每帧一次），把 onChange 换成 no-op 后 CPU
       * 从 106.6% 只降到 93.4%——说明负载来自 Excalidraw 内部对选中元素的重渲染，
       * 与本处的 viewTick 无关。选中矩形时只有 5.7%，可见是 image 这条路径特有。
       * 所以这段签名比较的真实价值是：签名不变时不推进一个本来就无意义的计数器，
       * 而**不是**消除了可观的开销。别拿它当"优化选中图片卡顿"的理由。
       */
      let viewChanged = false
      if (image) {
        const zoom = (appState.zoom as { value?: number } | undefined)?.value ?? 1
        const img = image as { x?: number; y?: number; width?: number; height?: number; angle?: number }
        const viewSig = [
          image.id,
          appState.scrollX,
          appState.scrollY,
          zoom,
          appState.width,
          appState.height,
          appState.offsetLeft,
          appState.offsetTop,
          img.x,
          img.y,
          img.width,
          img.height,
          img.angle,
        ].join('|')
        if (viewSig !== viewSigRef.current) {
          viewSigRef.current = viewSig
          viewChanged = true
        }
      } else {
        viewSigRef.current = ''
      }
      if (image && viewChanged && !viewTickRaf.current) {
        viewTickRaf.current = requestAnimationFrame(() => {
          viewTickRaf.current = 0
          setViewTick((value) => value + 1)
        })
      }
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

  /*
   * 点图片的交互（2026-10 改版）：
   * - 单击只「选中」，图片上方出现操作条（ImageActionBar），由用户决定下一步；
   * - 框选修改 = 操作条按钮 / 双击图片 / E 键；
   * - 引用到对话 = 操作条「更多」里的显式动作。
   * 旧版单击直接进编辑层并自动 @ 引用：想挪一下、缩放一下图片都会被编辑层抢走，
   * 输入框里也会堆满并非本意的引用。
   */

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
  //
  // 依赖用「稳定指纹」而不是 selectedImage 对象本身：selectedImage 来自 elements，
  // 而 elements 每次 onChange 都是 Excalidraw 给的新数组、元素对象也是新的，
  // 直接依赖对象会让这个 effect 在每一帧 onChange 后重跑一次。
  //
  // ⚠️ 归因修正（2026-10 实测）：最初以为这里就是「选中图片 85%CPU」的自激循环源头，
  // **不成立**。把这个 effect 整个短路（不再 probe、不再 setState）后，
  // 选中图片的空闲 CPU 从 89.8% 只降到 87.8%——它不是主因。
  // 主因在 Excalidraw 内部：onChange 换成 no-op 仍有 93.4%（对照组 106.6%），
  // ImageActionBar / ImagePreviewPanel 全关掉仍有 ~89.8%，0 次 unmount、纯重复渲染。
  // 所以这段指纹化的真实收益只是「不再每帧重复解码同一张图的 dataUrl」，
  // 属于消除无用功，**不要**当成修复选中卡顿的方案。
  const selectedImageSig = selectedImage
    ? [
        selectedImage.id,
        (selectedImage as { fileId?: string }).fileId ?? '',
        (selectedImage as { version?: number }).version ?? 0,
      ].join('|')
    : ''
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
        if (!alive) return
        // 值相同就复用旧对象：否则每次都是新引用，setState 必然再触发一轮渲染
        setSelectedImageInfo((prev) =>
          prev && prev.dataUrl === dataUrl && prev.width === w && prev.height === h
            ? prev
            : { dataUrl, width: w, height: h }
        )
      } catch {
        if (alive) setSelectedImageInfo(null)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedImageSig])

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

  const resizeImage = useCallback((element: CanvasElement, factor: number) => {
    const instance = apiRef.current
    if (!instance) return
    const elements = instance.getSceneElements()
    const current = elements.find((item) => item.id === element.id)
    if (
      !current ||
      current.type !== 'image' ||
      typeof current.width !== 'number' ||
      typeof current.height !== 'number' ||
      typeof current.x !== 'number' ||
      typeof current.y !== 'number'
    ) return
    const minimumFactor = Math.max(48 / current.width, 48 / current.height)
    const maximumFactor = Math.min(4096 / current.width, 4096 / current.height)
    const scale = Math.max(minimumFactor, Math.min(maximumFactor, factor))
    const width = current.width * scale
    const height = current.height * scale
    const dx = (width - current.width) / 2
    const dy = (height - current.height) / 2
    const next = elements.map((item) => {
      if (
        item.id !== current.id ||
        typeof item.x !== 'number' ||
        typeof item.y !== 'number'
      ) return item
      return { ...item, x: item.x - dx, y: item.y - dy, width, height }
    })
    instance.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }, [])

  /** 下载当前选中图片（PNG / JPG）。 */
  /* ------------------------------------------------------------------ */
  /* 选中图片的操作条                                                      */
  /* ------------------------------------------------------------------ */

  /** 操作条只在「恰好选中一张图、没在框选修改、没在拖动」时出现 */
  const barTarget =
    selectedIds.length === 1 && selectedImage && !editTarget && !interacting ? selectedImage : null

  const barRect = useMemo(() => {
    if (!barTarget) return null
    // 拖动后 elements 里的坐标可能还是旧的：直接向画布要最新的那一份
    const fresh =
      (apiRef.current?.getSceneElements().find((el) => el.id === barTarget.id) as
        | CanvasElement
        | undefined) ?? barTarget
    const rect = elementScreenRect(apiRef.current, fresh)
    // 缩得太小（缩略图那么大）时不弹操作条：按钮会比图片还大
    if (!rect || rect.w < 28 || rect.h < 28) return null
    return rect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barTarget, viewTick])

  const barParent = useMemo(
    () => (barTarget ? findParent(elements, barTarget) : null),
    [elements, barTarget]
  )
  const barVersion = useMemo(
    () => (barTarget ? versionOf(elements, barTarget) : 1),
    [elements, barTarget]
  )

  /** 画布上的图片 → File（一键操作与变体都要把像素交出去） */
  const elementFile = async (element: CanvasElement): Promise<File | null> => {
    const dataUrl = elementImageDataUrl(apiRef.current, element)
    if (!dataUrl) return null
    const blob = await (await fetch(dataUrl)).blob()
    return new File([blob], 'canvas-image.png', { type: blob.type || 'image/png' })
  }

  /** 一键整图操作（高清放大 / 去背景）：结果落在原图右侧，并记下版本谱系。 */
  const runQuickOp = async (op: 'enhance' | 'cutout') => {
    const element = barTarget
    if (!element || quickBusy) return
    if (!canAfford(prices.edit)) {
      setQuotaModalOpen(true)
      return
    }
    const label = t(`stage:ops.${op}`)
    setQuickBusy(op)
    try {
      const file = await elementFile(element)
      if (!file) {
        toast.error(t('stage:quick.failed', { op: label }))
        return
      }
      const prompt = QUICK_OP_PROMPT[op]
      const task = await generateApi.edit(
        {
          prompt,
          session_id: sessionId || undefined,
          canvas_id: canvasId ?? undefined,
          file,
          ops: [{ region: FULL_IMAGE_REGION, handler: op, prompt, intensity: 'fine' }],
        },
        newIdempotencyKey()
      )
      pushPlaceholder(
        task.id,
        { x: element.x ?? 0, y: element.y ?? 0, w: element.width ?? 320, h: element.height ?? 320 },
        { parentId: element.id, op }
      )
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.success(t('stage:quick.started', { op: label }), t('stage:quick.started_hint'))
    } catch (error) {
      toast.error(t('stage:quick.failed', { op: label }), errorMessage(error, te))
    } finally {
      setQuickBusy(null)
    }
  }

  /**
   * 再来一版：把这张图作为参考交给 Agent（走完整的分析 → 出图链路），
   * 而不是盲目重抽一次——Agent 会读图、沿用风格，结果出现在对话里。
   */
  const runVariation = async () => {
    const element = barTarget
    if (!element || quickBusy) return
    setQuickBusy('variation')
    try {
      const file = await elementFile(element)
      if (!file) return
      const ui = useUIStore.getState()
      ui.setAgentPanelOpen(true)
      if (!window.matchMedia('(min-width: 768px)').matches) ui.setMobileSegment('chat')
      useComposerHandoff.getState().stage(t('stage:quick.variation_prompt'), [file])
    } catch (error) {
      toast.error(t('stage:quick.failed', { op: t('stage:ops.variation') }), errorMessage(error, te))
    } finally {
      setQuickBusy(null)
    }
  }

  const openCompare = () => {
    if (!barTarget || !barParent) return
    const after = elementImageDataUrl(apiRef.current, barTarget)
    const before = elementImageDataUrl(apiRef.current, barParent)
    if (!after || !before) return
    setCompare({
      before: { url: before, version: Math.max(1, barVersion - 1) },
      after: { url: after, version: barVersion },
      op: readLineage(barTarget)?.op ?? 'region',
    })
  }

  // E 键 = 框选修改（选中图片时）。抢在 Excalidraw 之前：它的 E 是橡皮擦，
  // 而「选中一张图再按 E」的意图几乎总是编辑这张图
  useEffect(() => {
    if (!barTarget) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'e' || event.metaKey || event.ctrlKey || event.altKey) return
      const el = event.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      event.preventDefault()
      event.stopImmediatePropagation()
      void enterEdit(barTarget)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [barTarget, enterEdit])

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

  /** 复制当前选中图片到剪贴板（PNG：剪贴板只稳定支持 PNG）。 */
  const handleCopySelected = async () => {
    const dataUrl = selectedImageInfo?.dataUrl
    if (!dataUrl) return
    try {
      if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('unsupported')
      // 传 Promise 给 ClipboardItem：Safari 要求在用户手势的同一调用栈里创建条目
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': imageToBlob(dataUrl, 'png') })])
      toast.success(t('stage:preview.copied'))
    } catch {
      toast.error(t('stage:preview.copy_failed'))
    }
  }

  /**
   * 单图滚轮缩放：光标在哪张图上，滚轮就缩哪张图。
   *
   * 为什么不交给 Excalidraw：它把 wheel 一律当成画布缩放。但用户的心理模型是
   * 「我现在盯着这张图，我想把它放大看看细节」——尤其在几十张图的画布上，
   * 缩放整块画布会把周围内容全推走。这里在捕获阶段拦下事件：
   * - 命中图片 → 只改这张图的宽高，并保持光标下的画面点不动（放大不跑偏）；
   * - 没命中 → 放行，仍然是画布缩放；
   * - Ctrl / Cmd / Alt + 滚轮 → 一律放行（保住「强制缩放画布」的肌肉记忆）。
   */
  useEffect(() => {
    if (!api || editTarget) return
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const shell = target?.closest?.('.cs-canvas-shell') as HTMLElement | null
      if (!shell || !target || !shell.contains(target)) return
      const app = api.getAppState() as Record<string, unknown>
      if (app.viewModeEnabled) return

      const rect = shell.getBoundingClientRect()
      const zoomState = app.zoom as { value?: number } | number | undefined
      const zoom = Number(typeof zoomState === 'object' ? zoomState?.value : zoomState) || 1
      const scrollX = Number(app.scrollX || 0)
      const scrollY = Number(app.scrollY || 0)
      const sceneX = (event.clientX - rect.left) / zoom - scrollX
      const sceneY = (event.clientY - rect.top) / zoom - scrollY

      const images = allSceneElements(api).filter(
        (el) => el.type === 'image' && !(el as { isDeleted?: boolean }).isDeleted
      )
      const hit = [...images].reverse().find((el) => {
        const x = Number(el.x ?? 0)
        const y = Number(el.y ?? 0)
        const w = Number(el.width ?? 0)
        const h = Number(el.height ?? 0)
        return sceneX >= x && sceneX <= x + w && sceneY >= y && sceneY <= y + h
      })
      if (!hit) {
        // 没命中图片 = 画布缩放：给出明确的上下限（20%–400%）。
        // Excalidraw 自带 10%–3000%，滚过头会缩成一个小点、或放大到只剩几个像素，
        // 用户既看不出自己在哪，也很难缩回来。越界时直接吞掉这次滚轮。
        const step = Math.exp(-event.deltaY * 0.0016)
        const next = zoom * step
        if (next < 0.2 || next > 4) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }

      event.preventDefault()
      event.stopPropagation()

      const width = Number(hit.width ?? 0)
      const height = Number(hit.height ?? 0)
      if (!width || !height) return
      const factor = Math.exp(-event.deltaY * 0.0016)
      // 下限 40px（还能看见、能点中）；上限 4096（原图分辨率量级）
      const nextW = Math.min(4096, Math.max(40, width * factor))
      const scale = nextW / width
      const nextH = height * scale
      // 光标在原图中的相对位置保持不变 → 放大时不会「跑出视野」
      const ratioX = (sceneX - Number(hit.x ?? 0)) / width
      const ratioY = (sceneY - Number(hit.y ?? 0)) / height
      const nextX = sceneX - ratioX * nextW
      const nextY = sceneY - ratioY * nextH

      api.updateScene({
        elements: allSceneElements(api).map((el) =>
          el.id === hit.id
            ? { ...el, x: nextX, y: nextY, width: nextW, height: nextH }
            : el
        ),
        captureUpdate: 'IMMEDIATELY' as never,
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
  }, [api, editTarget])

  /** 顺时针旋转 90°：纯本地变换，不消耗额度。 */
  const rotateElement = (id: string) => {
    if (!api) return
    api.updateScene({
      elements: allSceneElements(api).map((el) =>
        el.id === id
          ? { ...el, angle: ((Number(el.angle) || 0) + Math.PI / 2) % (Math.PI * 2) }
          : el
      ),
      captureUpdate: 'IMMEDIATELY' as never,
    })
  }

  /** 把画布上的图收进素材库：之后在「从素材库选择」里能直接复用。 */
  const addElementToLibrary = async (el: CanvasElement) => {
    if (!api || addingToLibrary) return
    const dataUrl = elementImageDataUrl(api, el)
    if (!dataUrl) {
      toast.error('这张图暂时读不出来，稍后再试')
      return
    }
    setAddingToLibrary(true)
    try {
      const blob = await (await fetch(dataUrl)).blob()
      const ext = blob.type.includes('jpeg') ? 'jpg' : 'png'
      const file = new File([blob], `canvas-${el.id.slice(0, 6)}.${ext}`, { type: blob.type })
      await assetsApi.upload(file)
      toast.success('已收进素材库', '在素材库里可以继续复用或分享给团队')
    } catch (error) {
      toast.error('保存到素材库失败', errorMessage(error, te))
    } finally {
      setAddingToLibrary(false)
    }
  }

  /** 对话里点「已在画布 · 定位」：找到那张图并把视口推过去（顺带选中）。 */
  const locateResultOnCanvas = (url: string) => {
    if (!api) return
    const element = allSceneElements(api).find(
      (el) =>
        el.type === 'image' &&
        (el.customData as { sourceUrl?: string } | undefined)?.sourceUrl === url
    )
    if (!element) {
      toast.info('这张图还没放进画布', '在结果卡上点「放入画布」即可')
      return
    }
    focusSceneBox(
      api,
      {
        x: Number(element.x ?? 0),
        y: Number(element.y ?? 0),
        w: Number(element.width ?? 0),
        h: Number(element.height ?? 0),
      },
      { padding: 140, maxZoom: 1.2 }
    )
    api.updateScene({ appState: { selectedElementIds: { [element.id]: true } } })
    useUIStore.getState().setMobileSegment('canvas')
  }

  /** 取消画布上一个生成中的任务：后端会退回额度，占位卡立即收起。 */
  const cancelPlaceholder = async (taskIdToCancel: string) => {
    try {
      await generateApi.cancel(taskIdToCancel)
      setPlaceholders((prev) => prev.filter((item) => item.taskId !== taskIdToCancel))
      events.emit('tasks:changed')
      events.emit('quota:changed')
      toast.info(t('stage:gen.cancelled'))
    } catch (error) {
      toast.error(errorMessage(error, te))
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
      const { width, height } = resultDisplaySize(await imageSize(url))
      // 落点先找空位：直接放视口中心会盖住用户正在看的图
      const spot = findEmptySpot(instance, width, height)
      const created = await addImageToCanvas(instance, {
        url,
        assetId: await materializeResultAsset(url),
        width,
        height,
        x: spot.x,
        y: spot.y,
      })
      markUrlPlaced(url, canvasId)
      markTaskPlaced(taskIdInner, canvasId)
      dropIn(created.id)
      revealRef.current?.reveal([
        {
          x: created.x ?? spot.x,
          y: created.y ?? spot.y,
          w: created.width ?? RESULT_MAX_SIDE,
          h: created.height ?? RESULT_MAX_SIDE,
        },
      ])
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
        revealRef.current?.reveal(
          created.map((el) => ({ x: el.x ?? 0, y: el.y ?? 0, w: el.width ?? 0, h: el.height ?? 0 }))
        )
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
  const pushPlaceholder = (
    taskId: string,
    base: { x: number; y: number; w: number; h: number },
    lineage?: Lineage
  ) => {
    if (!api) return
    const appState = api.getAppState() as { zoom?: { value?: number }; scrollX?: number; scrollY?: number }
    const zoom = appState.zoom?.value ?? 1
    const scrollX = appState.scrollX ?? 0
    const scrollY = appState.scrollY ?? 0
    // 占位卡与最终落图同尺寸：结果出来时不跳变
    const { width: sceneW, height: sceneH } = resultDisplaySize({ width: base.w, height: base.h })
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
        startedAt: Date.now(),
        lineage,
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
              placed = await placeTaskResults(
                api,
                task,
                { x: ph.sceneX, y: ph.sceneY },
                canvasId,
                ph.lineage
              )
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
              revealRef.current?.reveal([{ x: ph.sceneX, y: ph.sceneY, w: ph.sceneW, h: ph.sceneH }])
              // Session tasks are announced by ChatPanel. Canvas-only tasks use this fallback.
              if (!task.session_id) {
                toast.success(
                  t('region.generated', { defaultValue: '生成完成，结果已放到画布' }),
                  task.result_urls.length > 1 ? `共 ${task.result_urls.length} 张结果` : undefined
                )
              }
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
    const currentUserId = useAuthStore.getState().user?.id || 'anonymous'
    addPromptHistory(currentUserId, payload.prompt, {
      model: 'gpt-image-2',
      aspect: 'auto',
      quality: 'standard',
      negative_prompt: '',
    })
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
        pushPlaceholder(
          task.id,
          {
            x: element.x ?? 0,
            y: element.y ?? 0,
            w: element.width ?? 320,
            h: element.height ?? 320,
          },
          { parentId: target.elementId, op: 'region' }
        )
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
      {/*
        Lovart 式三段：Agent 对话（左）→ 工作室抽屉（按需）→ 画布（主体）。
        各列之间不用 gap：收起的列宽度为 0，gap 会留下一道空缝；
        间距改由每列内容自带的右外边距承担，跟着列一起被裁掉。
      */}
      <div className="relative flex min-h-0 flex-1 p-1.5 pt-0 md:p-2 md:pt-2">
        {/* 左：Agent 对话（唯一的实例：靠 CSS 控制移动端/桌面端形态，避免双份轮询） */}
        <div
          ref={agentPanelRef}
          className={cn(
            'min-h-0 overflow-hidden',
            mobileSegment === 'chat' ? 'flex min-w-0 flex-1' : 'hidden',
            'md:flex md:flex-none'
          )}
        >
          {/* data-panel 挂在内层卡片上：外层的透明度/宽度归收放动效管，两路补间不抢同一个属性 */}
          <div
            data-panel
            data-agent-composer
            className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[16px] bg-surface shadow-sheet md:mr-2 md:w-[320px] lg:w-[336px] xl:w-[372px]"
          >
            {/* 面板顶部的弥散薄雾：蓝 → 青 → 薄荷，把对话区和画布在视觉上分开 */}
            <div aria-hidden className="cs-diffuse-wash pointer-events-none absolute inset-x-0 top-0 h-52" />
            <AgentPanelHeader onCreateSession={() => void handleCreateSession()} />
            <div className="min-h-0 flex-1">
              <ChatPanel
                canvasId={canvasId ?? undefined}
                sessionId={sessionId || null}
                selection={selectionCtx}
                onFocusCanvas={() => useUIStore.getState().setMobileSegment('canvas')}
                onLocateResult={locateResultOnCanvas}
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
        </div>

        {/* 工作室抽屉（历史对话 / 参考图 / 作品）：≥lg 推挤画布，更窄时浮在内容之上 */}
        {studioDrawerOpen && (
          <button
            type="button"
            aria-label={t('workspace:drawer.close')}
            onClick={closeStudioDrawer}
            className="absolute inset-0 z-30 bg-[var(--overlay)] backdrop-blur-[2px] lg:hidden"
          />
        )}
        <div
          ref={drawerRef}
          className="invisible absolute inset-y-2.5 left-2.5 z-40 flex min-h-0 overflow-hidden opacity-0 md:top-2.5 lg:visible lg:static lg:z-auto lg:w-0 lg:opacity-100"
        >
          <div className="flex h-full min-h-0 flex-col lg:mr-2">
            <StudioSidebar
              className="shadow-float lg:shadow-sheet"
              currentSessionId={sessionId || null}
              onSelectSession={(id) => {
                handleSessionChange(id)
                if (!window.matchMedia('(min-width: 1024px)').matches) closeStudioDrawer()
              }}
              onCreateSession={() => void handleCreateSession()}
              onDeleteSession={handleDeleteSession}
              onUseAsset={(asset) => void insertAsset(asset)}
              onUseWork={(url, id) => void handleAddResultToCanvas(url, id)}
              onUpload={() => uploadInputRef.current?.click()}
              onClose={closeStudioDrawer}
            />
          </div>
        </div>

        {/* 右：画布（页面主体） */}
        <div
          data-panel
          className={cn(
            // min-h-0 必填：缺了它，画布列的内容高度会把整行撑出视口
            'min-w-0 flex-1 flex-col gap-1.5',
            mobileSegment === 'canvas' ? 'flex min-h-0' : 'hidden md:flex md:min-h-0'
          )}
        >
          <CanvasTopBar>
            <CanvasHeader
              canvasId={canvasId}
              api={api}
              hasImageSelected={hasImageSelected}
              presence={
                collabScene.status !== 'idle' ? (
                  <CollabPresence
                    status={collabScene.status}
                    participants={collabScene.participants}
                    selfId={user?.id}
                    onFollow={(participant) =>
                      setFollowingId((prev) => (prev === participant.id ? null : participant.id))
                    }
                    followingId={followingId}
                    onUnfollow={() => setFollowingId(null)}
                  />
                ) : null
              }
            />
          </CanvasTopBar>
          <div
            ref={canvasCardRef}
            onPointerMove={handlePresenceMove}
            className={cn(
              // 画布做成浮起的纸卡：留出外边距 + 软角 + 暖灰阴影，
              // 底色用 --color-canvas（比纸底深一档），让图片浮起来；
              // 不靠 1px 描边定义边界——层级靠明度差 + 阴影表达
              // @container：画布内浮层（dock 文字标签、右下导航器位置）按画布宽度而不是视口宽度响应
              'cs-canvas-card @container relative min-h-0 flex-1 overflow-hidden rounded-[18px] bg-canvas shadow-sheet',
              // 选中图片时隐藏 Excalidraw 原生「双击裁剪」提示：
              // 本平台的图片编辑统一由单击进入编辑层，避免两个冲突的图片编辑入口
              selectedImage && 'cs-has-image-selected'
            )}
            onDoubleClickCapture={(e) => {
              const element = selectedImageRef.current
              if (!element) return
              // 双击图片 = 进入框选修改（顺手拦掉 Excalidraw 原生的双击裁剪，避免两个编辑入口）
              e.preventDefault()
              e.stopPropagation()
              if (editTargetRef.current?.elementId !== element.id) void enterEdit(element)
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
            {/* 空画布引导：没有任何元素、也没有在生成的东西时才出现 */}
            {api && visibleCount === 0 && placeholders.length === 0 && !editTarget && (
              <EmptyCanvas onUpload={() => uploadInputRef.current?.click()} onPickAsset={openAssetPicker} />
            )}

            {/* 协作者光标：只画不拦，跟随画布一起平移缩放 */}
            {api && !editTarget && (
              <RemoteCursors
                participants={collabScene.participants}
                selfId={user?.id}
                viewport={viewport}
              />
            )}

            {/* 打点评论：评论点跟随画布平移缩放；打点模式下整层接管点击 */}
            {api && !editTarget && (
              <CommentPins
                comments={commentState.items}
                viewport={viewport}
                placing={placingComment}
                activeId={activeCommentId}
                draft={draftPin}
                onPlace={(x, y) => {
                  setPlacingComment(false)
                  setDraftPin({ x, y })
                  setCollabOpen(true)
                  setCollabTab('comments')
                }}
                onOpen={(comment) => {
                  setActiveCommentId(comment.id)
                  setCollabOpen(true)
                  setCollabTab('comments')
                }}
              />
            )}

            <CollabPanel
              canvasId={canvasId ?? ''}
              open={collabOpen && Boolean(api) && !editTarget}
              tab={collabTab}
              onTab={setCollabTab}
              onClose={() => {
                setCollabOpen(false)
                setPlacingComment(false)
              }}
              comments={commentState.items}
              loading={commentState.loading}
              canWrite={collabScene.canWrite}
              activeId={activeCommentId}
              placing={placingComment}
              onTogglePlacing={() => {
                setCollabOpen(true)
                setCollabTab('comments')
                setPlacingComment((prev) => !prev)
              }}
              onOpenComment={(comment) => setActiveCommentId(comment.id)}
              onAddComment={async (content, parentId) => {
                const anchor =
                  draftPin ?? commentState.items.find((item) => item.id === activeCommentId)
                const created = await commentState.add({
                  content,
                  x: anchor?.x ?? 0,
                  y: anchor?.y ?? 0,
                  parent_id: parentId ?? null,
                })
                setDraftPin(null)
                if (created) setActiveCommentId(created.id)
                return created
              }}
              onResolve={(id, resolved) => commentState.resolve(id, resolved)}
              onDelete={(id) => commentState.remove(id)}
              onRestored={() => {
                void (async () => {
                  if (!canvasId) return
                  try {
                    const fresh = await canvasesApi.get(canvasId)
                    const state = fresh.state
                    if (state && api) {
                      api.updateScene({
                        elements: state.elements as never[],
                        captureUpdate: 'IMMEDIATELY' as never,
                      })
                    }
                  } catch {
                    toast.error('画布刷新失败', '请手动刷新页面查看恢复后的版本')
                  }
                })()
              }}
            />
            <CanvasToolbar
              api={api}
              history={history}
              onAddImage={openAssetPicker}
              onUpload={() => uploadInputRef.current?.click()}
              onDeleteSelected={handleDeleteSelected}
              onComments={() => {
                setCollabOpen((prev) => !prev)
                setCollabTab('comments')
              }}
              commentCount={commentState.unresolved}
              onVersions={() => {
                setCollabOpen(true)
                setCollabTab('versions')
              }}
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
                    if (element.type === 'image') selectedImageRef.current = element
                  }}
                  collapsed={false}
                />
              }
            />
            {placeholders.map((ph) => (
              <GeneratingCard
                key={ph.taskId}
                rect={{ x: ph.screenX, y: ph.screenY, w: ph.screenW, h: ph.screenH }}
                startedAt={ph.startedAt}
                onCancel={() => cancelPlaceholder(ph.taskId)}
              />
            ))}

            {/* 结果落画布的「显影」动效（纯视觉层，不拦截指针） */}
            <RevealLayer ref={revealRef} api={api} />

            {/* 选中图片的浮动操作条：框选修改 / 高清 / 去背景 / 再来一版 / 对比 / 下载 */}
            {barTarget && barRect && (
              <ImageActionBar
                rect={barRect}
                targetKey={barTarget.id}
                naturalSize={
                  selectedImageInfo
                    ? { width: selectedImageInfo.width, height: selectedImageInfo.height }
                    : null
                }
                version={barVersion}
                canCompare={Boolean(barParent)}
                busy={quickBusy}
                cost={prices.edit}
                onEdit={() => void enterEdit(barTarget)}
                onEnhance={() => void runQuickOp('enhance')}
                onCutout={() => void runQuickOp('cutout')}
                onVariation={() => void runVariation()}
                onResize={(factor) => resizeImage(barTarget, factor)}
                onCompare={openCompare}
                onDownload={(format) => void handleDownloadSelected(format)}
                onReference={() => {
                  void referenceCanvasImage(barTarget)
                  focusAgentComposer()
                }}
                onCopy={() => void handleCopySelected()}
                onDelete={() => handleDeleteElement(barTarget.id)}
                onRotate={() => rotateElement(barTarget.id)}
                onAddToLibrary={() => void addElementToLibrary(barTarget)}
                addingToLibrary={addingToLibrary}
              />
            )}

            {/* 右下角导航器：选中图信息卡 / 全景 · 胶片 / 缩放条 */}
            {api && (
              <CanvasNavigator
                api={api}
                elements={elements}
                selectionCard={
                  selectedImageInfo?.dataUrl ? (
                    <ImagePreviewPanel
                      imageUrl={selectedImageInfo.dataUrl}
                      width={selectedImageInfo.width}
                      height={selectedImageInfo.height}
                      // 已在编辑层里时不再给「编辑」入口（编辑层本身就是）
                      onEdit={
                        editTarget
                          ? undefined
                          : () => {
                              if (selectedImage) void enterEdit(selectedImage)
                            }
                      }
                      onDownload={(format) => void handleDownloadSelected(format)}
                      onCopy={() => void handleCopySelected()}
                      onSendToChat={() => {
                        if (!selectedImage) return
                        void referenceCanvasImage(selectedImage)
                        focusAgentComposer()
                      }}
                      onDelete={() => {
                        if (selectedImage) handleDeleteElement(selectedImage.id)
                      }}
                    />
                  ) : null
                }
              />
            )}

            <CanvasDropZone
              targetRef={canvasCardRef}
              onFile={(file) => setUploadFile(file)}
              onReject={() => toast.info(t('stage:drop.reject'))}
            />

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

      </div>

      {compare && (
        <CompareDialog
          before={compare.before}
          after={compare.after}
          opLabel={t(`stage:ops.${compare.op}`)}
          onClose={() => setCompare(null)}
        />
      )}

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
