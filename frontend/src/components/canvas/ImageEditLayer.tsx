import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Brush,
  Check,
  Eraser,
  Frame,
  Lasso,
  Loader2,
  PenLine,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { generateApi, type EditCapability, type EditOpPayload } from '@/lib/api/generate'
import { PolishPopover } from '@/components/chat/PolishPopover'
import {
  buildEditPayload,
  paintBrushStroke,
  paintStrokePath,
  paintUnionMask,
  strokesBBox,
  type BrushRegionInput,
  type DoodleStroke,
  type NormRegion,
} from './canvas-helpers'
import {
  editDraftKey,
  markRestoreNotified,
  readEditDraft,
  writeEditDraft,
  type EditRegion,
  type RegionKind,
} from './edit-draft'

/**
 * 工具集合。
 *
 * - `region` / `lasso`：矩形框选 / 自由套索，产出「选区 + 指令」；
 * - `brush`：**画笔自由选区**——像涂鸦一样画，松手即成为一个可填指令的选区，
 *   同一区域可以反复续画细节（笔迹合并、区域不增加）；
 * - `pen`：标注涂鸦，只是给上游的视觉提示，不构成选区；
 * - `eraser`：只擦标注笔迹，**不影响画笔选区**。
 */
type Tool = 'region' | 'lasso' | 'brush' | 'pen' | 'eraser'


/**
 * 编辑层的命令式接口（供画布侧在需要时单独取掩码）。
 *
 * 为什么要有它：提交路径可能不在本组件内（例如画布侧先落占位、后补掩码），
 * 掩码又必须由「当前选区状态」现算，所以只能由组件自己暴露一个取值方法。
 */
export interface ImageEditLayerHandle {
  /** 生成并集掩码 PNG（透明=可编辑）；无选区返回 null */
  getMaskFile: () => Promise<File | null>
  /**
   * 编辑层是否还有「打开的表面」——展开的气泡**或**正在拖拽的选区。
   * 宿主用它做 Esc 的唯一裁决点：有表面 → 只收表面；没有 → 退出编辑。
   *
   * 刻意不叫 hasActiveBubble：它还涵盖拖拽中，叫 bubble 会诱导后来者只判 activeRegionId，
   * 于是「拖到一半按 Esc 直接退出编辑」这种回归会再次出现。
   */
  hasOpenSurface: () => boolean
  /**
   * 收起当前表面：拖拽中 → 中止拖拽并恢复原气泡；否则 → 收气泡 + 焦点还给 chip。
   */
  collapseActiveSurface: () => void
}

/**
 * 提示词意图快捷识别。
 *
 * 用户写「抠出来」时，若还停留在默认的「改样式」，结果就会被当成改样式提交，
 * 于是「框了抠图却没有抠图」。这里按关键词即时纠正，并把选择权留给用户
 * （手动选过能力的区域不再被自动改写）。
 *
 * 注意：这只是**输入辅助**，不是能力定义——能力清单始终来自后端注册表，
 * 管理员新增的能力不会被这里限制，只是不会自动识别而已。
 */
const INTENT_KEYWORDS: Array<{ handler: string; keywords: string[] }> = [
  {
    handler: 'cutout',
    keywords: ['抠', '去背景', '去底', '透明背景', '贴纸', '提取出来', '摘出来', '单独拿出来'],
  },
  { handler: 'transparent', keywords: ['挖空', '掏空', '留空', '变透明', '透明化'] },
  { handler: 'remove', keywords: ['去掉', '移除', '去除', '抹掉', '消除', '擦除'] },
  {
    handler: 'enhance',
    keywords: ['变清晰', '更清晰', '提高画质', '画质增强', '修复模糊', '去噪', '高清'],
  },
]

/** 按提示词推断应使用的能力；无法判断时返回 null。 */
function detectHandler(text: string, available: Set<string>): string | null {
  const value = text.trim()
  if (!value) return null
  for (const rule of INTENT_KEYWORDS) {
    if (!available.has(rule.handler)) continue
    if (rule.keywords.some((word) => value.includes(word))) return rule.handler
  }
  return null
}

/**
 * 能力清单拉取失败时的最小兜底。
 * 主路径始终以后端注册表为准——管理员新增能力后这里无需改动。
 */
const FALLBACK_HANDLERS: EditCapability[] = [
  {
    id: 'restyle',
    label: '改样式',
    description: '',
    engine: 'upstream',
    output: 'composite',
    per_region: false,
    billable: true,
    executor: '',
    has_builtin_prompt: false,
  },
  {
    id: 'cutout',
    label: '抠图',
    description: '',
    engine: 'upstream',
    output: 'sprite',
    per_region: true,
    billable: true,
    executor: '',
    has_builtin_prompt: true,
  },
]

interface ImageEditLayerProps {
  open: boolean
  /** 编辑目标图（dataURL） */
  dataUrl: string
  naturalWidth: number
  naturalHeight: number
  /** 图片在画布容器内的显示矩形（精确贴合画布原图位置，不缩放不位移） */
  imgRect?: { x: number; y: number; w: number; h: number } | null
  submitting?: boolean
  /** 用户提示词（受控） */
  prompt: string
  onPromptChange: (value: string) => void
  /** 内置提示词前缀说明（来自后端配置，只读展示） */
  promptTemplate?: string
  /** 「去创作」：把框选需求交给右侧对话面板（由 AI 分析后生成） */
  onGoCreate?: (payload: { prompt: string }) => void
  /** 内置提示词预设 */
  presets?: Array<{ id: string; label: string; prompt: string }>
  /** 可用编辑能力（后端注册表驱动；缺省时用最小兜底） */
  handlers?: EditCapability[]
  /**
   * 草稿键：同一张图的未提交编辑（选区 + 每区提示词 + 标注）按它存档。
   * 键由画布元素 id + 图片指纹组成——图片被重新生成后指纹变化，草稿自然失效，
   * 不会把上一版图的选区套到新图上。
   */
  draftKey?: string | null
  onClose: () => void
  onSubmit: (payload: {
    baseFile: File
    maskFile: File | null
    guideFile: File | null
    regions: NormRegion[]
    ops: EditOpPayload[]
    prompt: string
  }) => void
  onDelete?: () => void
  onError?: (message: string) => void
  /** 中性提示（如 AI 分析完成） */
  onNotice?: (message: string) => void
  /**
   * 选区变化回调：区域数 / 版本号 / 是否有涂鸦。
   * 侧边栏的「需求分析」需要知道当前选区状态，才能在选区变化后把旧结论标记为失效。
   */
  onSelectionChange?: (info: {
    count: number
    revision: number
    hasDoodle: boolean
    regions: Array<{
      index: number
      region: NormRegion
      path?: Array<{ x: number; y: number }>
      prompt: string
      handler: string
    }>
  }) => void
}

const COLORS = ['#dc2626', '#f59e0b', '#2563eb', '#16a34a', '#ffffff']
const SIZES = [
  { label: '细', value: 0.004 },
  { label: '中', value: 0.009 },
  { label: '粗', value: 0.018 },
]
const ERASE_SCALE = 2.4
const MIN_BOX_PX = 10
/** 选区数量上限（矩形 / 套索 / 画笔共用同一预算，避免气泡糊满屏幕） */
const MAX_REGIONS = 8
/** 单个画笔区域最多合并的笔数：再多说明应该另起一个区域 */
const MAX_BRUSH_STROKES = 6
/** 画笔笔迹的显示/掩码颜色（固定红色，与区域描边同色系） */
const BRUSH_COLOR = '#dc2626'
/** 画笔最小笔宽：太细的笔迹在缩放后几乎看不见，选区会「消失」 */
const BRUSH_MIN_WIDTH = 0.012
/** 采样抽稀阈值（归一化）：相邻点太近直接跳过，避免顶点爆炸 */
const SAMPLE_MIN_DISTANCE = 0.002
/** 气泡最小 top：不得盖住顶部工具条 */
const BUBBLE_MIN_TOP = 96
/** 提交校验不通过时的抖动时长（毫秒） */
const SHAKE_DURATION = 300
/**
 * 「点一下」的位移容差（屏幕像素）：鼠标 6、手指 12（按下会漂）。
 * 判据用 `pointerType` 而不是 `pointer: coarse` 媒体查询——后者描述的是**主输入设备**，
 * 触屏笔记本上主指针是鼠标会返回 fine，手指反而按 6px 判，是反向失效。
 *
 * 灰区（触屏 12px 档下 10~14px 位移）**故意保留**：结果是「什么都不发生、气泡原样保留」，
 * 不丢内容、不误收、不误建，是三种可能里最安全的一种。禁止为「区间好看」去调阈值。
 */
const CLICK_SLOP_FINE = 6
const CLICK_SLOP_COARSE = 12

/** 合并两个归一化包围盒（取并集）。 */
function unionRegion(a: NormRegion, b: NormRegion): NormRegion {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.w, b.x + b.w)
  const bottom = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: Math.max(0.01, right - x), h: Math.max(0.01, bottom - y) }
}

/** 点是否落在包围盒内（用于「续画合并到同一区域」的命中判断）。 */
function containsPoint(region: NormRegion, point: { x: number; y: number }): boolean {
  return (
    point.x >= region.x &&
    point.x <= region.x + region.w &&
    point.y >= region.y &&
    point.y <= region.y + region.h
  )
}

/** 笔迹的像素长度（用于丢弃误触点）；宽度按容器宽、高度按容器高换算。 */
function strokePixelLength(
  stroke: DoodleStroke,
  boxW: number,
  boxH: number
): number {
  let total = 0
  for (let i = 1; i < stroke.points.length; i += 1) {
    const dx = (stroke.points[i].x - stroke.points[i - 1].x) * boxW
    const dy = (stroke.points[i].y - stroke.points[i - 1].y) * boxH
    total += Math.hypot(dx, dy)
  }
  return total
}

/**
 * 统一的图片编辑层（类 Figma 就地编辑）：
 * - 框选 / 套索 / 画笔：三种方式产出的选区结构完全一致（区域 + 指令 + 能力），
 *   可以自由混用，数量上限共享；
 * - 画笔 / 橡皮：直接在原图上涂鸦标注（只作为上游的视觉提示，不构成选区）；
 * - 提示词：按区域在气泡里填写，随「带标记的图 + 并集掩码」一并提交上游执行图生图。
 * 编辑层精确贴合画布上的原图位置，不改变页面布局。
 */
export const ImageEditLayer = forwardRef<ImageEditLayerHandle, ImageEditLayerProps>(
  function ImageEditLayer(
    {
      open,
      dataUrl,
      naturalWidth,
      naturalHeight,
      imgRect,
      submitting,
      prompt,
      onPromptChange,
      presets = [],
      handlers,
      draftKey,
      onGoCreate,
      onSelectionChange,
      onClose,
      onSubmit,
      onDelete,
      onError,
      onNotice,
    },
    ref
  ) {
    const [tool, setTool] = useState<Tool>('region')
    const [color, setColor] = useState(COLORS[0])
    const [size, setSize] = useState(SIZES[1].value)
    const [regions, setRegions] = useState<EditRegion[]>([])
    const [draftRect, setDraftRect] = useState<NormRegion | null>(null)
    /** 套索正在绘制的顶点（归一化） */
    const [lassoPoints, setLassoPoints] = useState<Array<{ x: number; y: number }>>([])
    const [strokeCount, setStrokeCount] = useState(0)
    const [canRedo, setCanRedo] = useState(false)
    const [safeSrc, setSafeSrc] = useState('')
    const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
    const [analyzing, setAnalyzing] = useState(false)
    const [composerOpen, setComposerOpen] = useState(true)
    const [thinking, setThinking] = useState<string[]>([])
    /** 当前正在就地输入的区域（框选后自动聚焦到该区域的气泡） */
    const [activeRegionId, setActiveRegionId] = useState<string | null>(null)
    /** 正在拖拽画选区：此间隐藏所有气泡与 chip，避免挡住正在画的那一块 */
    const [drafting, setDrafting] = useState(false)
    /** 指针按下时的屏幕坐标：用来区分「点一下」和「拖了一点但没画成」 */
    const pointerStartScreenRef = useRef<{ x: number; y: number } | null>(null)
    /** 输入法组词中：此时开始框选要先把组词提交掉，否则没上屏的拼音会丢 */
    const composingRef = useRef(false)
    /** 提交校验失败时的抖动位移（纯 JS 驱动，不引入新依赖、不改全局样式） */
    const [shake, setShake] = useState<{ id: string; dx: number } | null>(null)
    const [focusToken, setFocusToken] = useState(0)
    const rootRef = useRef<HTMLDivElement>(null)
    /** 当前展开气泡的 DOM：判断「点的是不是气泡外部」 */
    const bubbleRef = useRef<HTMLDivElement>(null)
    /** 已完成草稿水合的图片键：未水合前不允许把 state 写回草稿 */
    const hydratedKeyRef = useRef<string | null>(null)
    /** onNotice 走 ref：它是宿主的内联函数，放进 effect 依赖会导致每次渲染都重置编辑状态 */
    const noticeRef = useRef(onNotice)
    noticeRef.current = onNotice
    const [rootSize, setRootSize] = useState({ w: 0, h: 0 })

    // 能力清单完全由后端注册表驱动：管理员新增能力后，这里自动出现
    const catalog = handlers && handlers.length > 0 ? handlers : FALLBACK_HANDLERS
    const handlerById = useMemo(() => {
      const map: Record<string, EditCapability> = {}
      for (const item of catalog) map[item.id] = item
      return map
    }, [catalog])
    const defaultHandlerId = catalog[0]?.id ?? 'restyle'
    const availableHandlers = useMemo(() => new Set(catalog.map((item) => item.id)), [catalog])

    /**
     * 该能力是否必须由用户填写指令。
     * 带内置提示词的能力（抠图 / 去物 / 增强）由平台提示词驱动，用户不必再写。
     */
    const needsPrompt = useCallback(
      (handlerId: string) => {
        const item = handlerById[handlerId]
        if (!item) return true
        return item.engine === 'upstream' && !item.has_builtin_prompt
      },
      [handlerById]
    )

    const wrapperRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    /** 画笔选区显示层：与标注涂鸦分层，互不覆盖 */
    const brushCanvasRef = useRef<HTMLCanvasElement>(null)
    const imgRef = useRef<HTMLImageElement>(null)
    const strokesRef = useRef<DoodleStroke[]>([])
    const redoRef = useRef<DoodleStroke[]>([])
    const currentRef = useRef<DoodleStroke | null>(null)
    const drawingRef = useRef(false)
    /** 画笔当前正在画的一笔 */
    const brushStrokeRef = useRef<DoodleStroke | null>(null)
    /** 画笔笔迹的加入顺序（撤销画笔按此 LIFO 回退） */
    const brushHistoryRef = useRef<Array<{ regionId: string }>>([])
    /** 选区状态镜像：指针事件回调里需要读到最新值，避免闭包拿到旧数组 */
    const regionsRef = useRef<EditRegion[]>([])
    /** 掩码用的底图位图缓存：只在 getMaskFile 时按需加载一次 */
    const maskBitmapRef = useRef<ImageBitmap | null>(null)
    /** 气泡内 textarea 的引用（提交校验失败时要聚焦到具体区域） */
    const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
    /** chip 的引用：Esc 收起气泡后把焦点还给它，键盘用户不会「掉到画布上」 */
    const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({})
    /** 待聚焦的区域（与 focusToken 配合，避免重复聚焦） */
    const focusTargetRef = useRef<string | null>(null)
    const regionStartRef = useRef<{ x: number; y: number } | null>(null)
    const lassoRef = useRef<Array<{ x: number; y: number }>>([])
    const lassoRafRef = useRef(0)
    const rafRef = useRef(0)
    const brushRafRef = useRef(0)
    const shakeTimersRef = useRef<number[]>([])

    useEffect(() => {
      regionsRef.current = regions
    }, [regions])

    // 跨域图片转 objectURL：避免 canvas 被污染导致导出（toBlob）失败
    useEffect(() => {
      if (!open || !dataUrl) {
        setSafeSrc('')
        return
      }
      if (dataUrl.startsWith('data:') || dataUrl.startsWith('blob:')) {
        setSafeSrc(dataUrl)
        return
      }
      let objectUrl: string | null = null
      let cancelled = false
      const load = async () => {
        try {
          const resp = await fetch(dataUrl, { mode: 'cors' })
          if (!resp.ok) throw new Error('load failed')
          const blob = await resp.blob()
          if (cancelled) return
          objectUrl = URL.createObjectURL(blob)
          setSafeSrc(objectUrl)
        } catch {
          if (!cancelled) setSafeSrc(dataUrl)
        }
      }
      void load()
      return () => {
        cancelled = true
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
    }, [open, dataUrl])

    // 底图变了就丢弃位图缓存，避免掩码用到上一张图
    useEffect(() => {
      maskBitmapRef.current?.close?.()
      maskBitmapRef.current = null
    }, [safeSrc, dataUrl])

    /**
     * 每次打开 / 切换编辑对象：先把**这张图**的草稿恢复出来，再重置临时交互态。
     *
     * 这里刻意不再 `setRegions([])`：退出编辑（点画布空白、点「完成」）与切图
     * 都会重新走进来，无脑清空正是「框好的区域和写好的提示词全没了」的根因。
     * 草稿按图片 id 存，多图交替编辑各自恢复各自的，互不干扰。
     */
    useEffect(() => {
      if (!open) return
      const key = draftKey ?? null
      const draft = readEditDraft(key)
      const nextRegions = draft?.regions ?? []
      const nextStrokes = draft?.strokes ?? []
      setRegions(nextRegions)
      regionsRef.current = nextRegions
      strokesRef.current = nextStrokes
      // 画笔撤销历史按区域顺序重建：恢复后「撤销画笔」仍然可用（跨区域交错会退化为区域顺序）
      const history: Array<{ regionId: string }> = []
      for (const item of nextRegions) {
        if (item.kind !== 'brush') continue
        for (let i = 0; i < (item.strokes?.length ?? 0); i += 1) history.push({ regionId: item.id })
      }
      brushHistoryRef.current = history
      redoRef.current = []
      setStrokeCount(nextStrokes.length)
      setCanRedo(false)
      setDraftRect(null)
      setLassoPoints([])
      lassoRef.current = []
      setTool('region')
      currentRef.current = null
      brushStrokeRef.current = null
      drawingRef.current = false
      regionStartRef.current = null
      setComposerOpen(true)
      setThinking([])
      setActiveRegionId(null)
      setShake(null)
      setDrafting(false)
      hydratedKeyRef.current = key
      // 同一张图每次会话只提示一次「已恢复」，反复进出不刷屏
      if (nextRegions.length > 0 && markRestoreNotified(key)) {
        noticeRef.current?.(`已恢复上次的 ${nextRegions.length} 个选区`)
      }
      // 依赖里只放 open / draftKey：onNotice 是内联函数，放进依赖会导致每次渲染都重置
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, draftKey])

    /**
     * 草稿落盘：选区 / 每区提示词 / 标注一变就写回。
     *
     * 守卫 `regionsRef.current !== regions` 很关键：切图那一帧，`regions` 还是上一张图的
     * 旧数组，而水合刚把 regionsRef 换成新图的——此时写回会把 A 图的选区灌进 B 图的草稿。
     */
    useEffect(() => {
      if (!open) return
      const key = draftKey ?? null
      if (!key) return
      if (hydratedKeyRef.current !== key) return
      if (regionsRef.current !== regions) return
      writeEditDraft(key, { regions, strokes: strokesRef.current })
    }, [regions, strokeCount, open, draftKey])

    // 笔迹恢复 / 撤销重做后重绘标注层（regions 变化只重绘画笔层，不覆盖标注层）
    useEffect(() => {
      redraw()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [strokeCount])

    /**
     * 点击气泡外部即收起（「完成输入后自动隐藏」）。
     *
     * 三类例外：
     * - 点在气泡自己身上：继续编辑；
     * - 点 Portal 浮层（润色面板等）：不算点外部，否则一开润色气泡就被收掉；
     * - 点在图片上：交给拖拽逻辑处理（松手时按「是否新建了选区」决定收起还是换区）。
     */
    useEffect(() => {
      if (!activeRegionId) return
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target
        if (!(target instanceof Element)) return
        if (target.closest('[data-edit-surface]')) return
        if (target.closest('[data-radix-popper-content-wrapper]')) return
        if (bubbleRef.current?.contains(target)) return
        if (wrapperRef.current?.contains(target)) return
        setActiveRegionId(null)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      return () => document.removeEventListener('pointerdown', onPointerDown, true)
    }, [activeRegionId])


    /**
     * 选区版本号：**只在选区结构变化时递增**（增删选区、换能力、改几何）。
     * 改提示词不算——提示词只是给这张图的说明，不影响「这份计划针对哪个选区算的」。
     * 侧边栏拿它判断旧结论是否已失效。
     */
    const revisionRef = useRef(0)
    const selectionSigRef = useRef('')
    const selectionCbRef = useRef(onSelectionChange)
    selectionCbRef.current = onSelectionChange
    useEffect(() => {
      // 切图那一帧 regions 还是上一张图的数组，水合刚把 regionsRef 换成新图的：
      // 此时上报会先用「A 的选区 + B 的 asset_id」错报一次、revision 连跳两下，直接跳过。
      if (regionsRef.current !== regions) return
      const sig = regions
        .map(
          (item) =>
            `${item.id}:${item.kind}:${item.handler}:${item.region.x},${item.region.y},${item.region.w},${item.region.h}:${item.path?.length ?? 0}:${item.strokes?.length ?? 0}`
        )
        .join('|')
      if (sig !== selectionSigRef.current) {
        selectionSigRef.current = sig
        revisionRef.current += 1
      }
      selectionCbRef.current?.({
        count: regions.length,
        revision: revisionRef.current,
        hasDoodle: strokeCount > 0,
        regions: regions.map((item, index) => ({
          index: index + 1,
          region: item.region,
          path: item.path,
          prompt: item.prompt,
          handler: item.handler,
        })),
      })
    }, [regions, strokeCount])

    /** 绘制标注涂鸦层（已完成笔迹 + 正在画的一笔）。 */
    const redraw = useCallback(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (w <= 0 || h <= 0) return
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      // 与导出标注图共用同一套笔迹算法（perfect-freehand），保证所见即所得
      strokesRef.current.forEach((stroke) => paintStrokePath(ctx, stroke, w, h))
      if (currentRef.current) paintStrokePath(ctx, currentRef.current, w, h)
    }, [])

    /** 绘制画笔选区层（所有画笔区域的笔迹 + 正在画的一笔）。 */
    const redrawBrush = useCallback(() => {
      const canvas = brushCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.width / dpr
      const h = canvas.height / dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      if (w <= 0 || h <= 0) return
      for (const item of regionsRef.current) {
        if (item.kind !== 'brush' || !item.strokes) continue
        for (const stroke of item.strokes) paintBrushStroke(ctx, stroke, w, h)
      }
      const draft = brushStrokeRef.current
      if (draft) paintBrushStroke(ctx, draft, w, h)
    }, [])

    /**
     * 中止当前拖拽（Esc 与 pointercancel 共用同一实现）。
     *
     * 语义：**只撤销「正在进行的这一笔」**——不落选区、不留半截笔迹、不动已有选区与气泡。
     * 收成一个函数的原因：Esc 与系统打断必须完全等价，否则「按 Esc 没事、来电却多出个框」
     * 这类只在特定设备上复现的差异会一直存在。
     */
    const abortDrafting = useCallback(() => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      if (brushRafRef.current) {
        cancelAnimationFrame(brushRafRef.current)
        brushRafRef.current = 0
      }
      if (lassoRafRef.current) {
        cancelAnimationFrame(lassoRafRef.current)
        lassoRafRef.current = 0
      }
      regionStartRef.current = null
      pointerStartScreenRef.current = null
      lassoRef.current = []
      brushStrokeRef.current = null
      currentRef.current = null
      drawingRef.current = false
      setDraftRect(null)
      setLassoPoints([])
      setDrafting(false)
      // 重绘两层：把「正在画的那一笔」从画面上抹掉。套索由 SVG 层按 state 渲染，
      // 这两次重绘对它是空操作——统一调用比按工具分支更不容易漏。
      redraw()
      redrawBrush()
    }, [redraw, redrawBrush])

    // 选区变化后重画画笔层（增删区域、续画、撤销都走这条路）
    useEffect(() => {
      redrawBrush()
    }, [regions, redrawBrush])

    // 尺寸同步（含 imgRect 变化、窗口缩放、画布缩放）
    useEffect(() => {
      if (!open) return
      const el = wrapperRef.current
      if (!el) return
      const sync = () => {
        const w = el.clientWidth
        const h = el.clientHeight
        if (w === 0 || h === 0) return
        const dpr = window.devicePixelRatio || 1
        for (const canvas of [canvasRef.current, brushCanvasRef.current]) {
          if (!canvas) continue
          canvas.width = Math.round(w * dpr)
          canvas.height = Math.round(h * dpr)
          canvas.style.width = `${w}px`
          canvas.style.height = `${h}px`
        }
        setBoxSize({ w, h })
        redraw()
        redrawBrush()
      }
      sync()
      const ro = new ResizeObserver(sync)
      ro.observe(el)
      window.addEventListener('resize', sync)
      return () => {
        ro.disconnect()
        window.removeEventListener('resize', sync)
        if (rafRef.current) cancelAnimationFrame(rafRef.current)
        if (brushRafRef.current) cancelAnimationFrame(brushRafRef.current)
      }
    }, [open, redraw, redrawBrush, imgRect?.w, imgRect?.h, imgRect?.x, imgRect?.y])

    // 量一下根容器尺寸：区域气泡要据此判断「放得下就放框下面，放不下就翻到框上面」
    useEffect(() => {
      const el = rootRef.current
      if (!el) return
      const measure = () => setRootSize({ w: el.clientWidth, h: el.clientHeight })
      measure()
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      return () => ro.disconnect()
    }, [open])

    // 卸载时清掉抖动定时器，避免对已卸载组件 setState
    useEffect(
      () => () => {
        shakeTimersRef.current.forEach((timer) => window.clearTimeout(timer))
        shakeTimersRef.current = []
      },
      []
    )

    /** 屏幕坐标 → 归一化图片坐标 */
    const toNorm = (clientX: number, clientY: number): { x: number; y: number } => {
      const el = wrapperRef.current
      if (!el) return { x: 0, y: 0 }
      const b = el.getBoundingClientRect()
      return {
        x: Math.min(1, Math.max(0, (clientX - b.left) / Math.max(1, b.width))),
        y: Math.min(1, Math.max(0, (clientY - b.top) / Math.max(1, b.height))),
      }
    }

    /**
     * 收起当前展开的气泡（有字没字都收）。
     *
     * 口径变更：旧逻辑「没写字就保持展开」正是气泡挡住下一次框选的根因——
     * 用户框完第一个区域还没写，就去框第二个，旧气泡一直浮在图上。
     * 现在收起后仍是 chip（带着「填写说明」的提示），点它或区域编号就能重新展开，
     * 信息没有丢失，只是不再占着画面。
     */
    const collapseActiveBubble = useCallback(() => setActiveRegionId(null), [])

    /** 新建一个选区（矩形 / 套索 / 画笔共用），并把它设为当前输入目标。 */
    const createRegion = (params: {
      kind: RegionKind
      region: NormRegion
      path?: Array<{ x: number; y: number }>
      strokes?: DoodleStroke[]
    }): string | null => {
      if (regionsRef.current.length >= MAX_REGIONS) {
        onError?.(`最多支持 ${MAX_REGIONS} 个选区，请先删掉一个`)
        return null
      }
      const newId = crypto.randomUUID()
      setRegions((prev) => [
        ...prev,
        {
          id: newId,
          kind: params.kind,
          handler: defaultHandlerId,
          prompt: '',
          region: params.region,
          path: params.path,
          strokes: params.strokes,
        },
      ])
      // 画完就地把输入气泡弹在这个区域旁边，用户不用再跑去底部输入
      setActiveRegionId(newId)
      setComposerOpen(true)
      return newId
    }

    const handleRegionDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (submitting) return
      // 开始画新选区：先把所有气泡/chip 隐掉（不卸载，松手后原样回来），
      // 避免旧气泡盖住正在拖的框。**不在这里收起**——万一拖到一半放弃，
      // 用户正在写的内容还要原样留在气泡里。
      setDrafting(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      pointerStartScreenRef.current = { x: e.clientX, y: e.clientY }
      const p = toNorm(e.clientX, e.clientY)
      regionStartRef.current = p
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 })
    }

    const handleRegionMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const start = regionStartRef.current
      if (!start) return
      const p = toNorm(e.clientX, e.clientY)
      setDraftRect({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      })
    }

    const handleRegionUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const start = regionStartRef.current
      const screenStart = pointerStartScreenRef.current
      regionStartRef.current = null
      pointerStartScreenRef.current = null
      setDraftRect(null)
      setDrafting(false)
      if (!start) return
      const p = toNorm(e.clientX, e.clientY)
      const el = wrapperRef.current
      const boxW = el?.clientWidth ?? 1
      const boxH = el?.clientHeight ?? 1
      const pxW = Math.abs(p.x - start.x) * boxW
      const pxH = Math.abs(p.y - start.y) * boxH
      if (pxW < MIN_BOX_PX || pxH < MIN_BOX_PX) {
        // 没画成选区：真的只是「点了一下」才收起气泡；拖了一点又不够大算手抖，
        // 保持原气泡（连同已写的内容）不动。阈值按指针类型取（鼠标 6 / 手指 12）。
        const slop = e.pointerType === 'touch' ? CLICK_SLOP_COARSE : CLICK_SLOP_FINE
        const moved = screenStart
          ? Math.hypot(e.clientX - screenStart.x, e.clientY - screenStart.y)
          : 0
        if (moved < slop) collapseActiveBubble()
        return
      }
      createRegion({
        kind: 'rect',
        region: {
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          w: Math.abs(p.x - start.x),
          h: Math.abs(p.y - start.y),
        },
      })
    }

    /** 套索：按住画一圈，松手闭合成多边形选区。 */
    const handleLassoDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (submitting) return
      setDrafting(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      pointerStartScreenRef.current = { x: e.clientX, y: e.clientY }
      const p = toNorm(e.clientX, e.clientY)
      lassoRef.current = [p]
      setLassoPoints([p])
    }

    const handleLassoMove = (e: React.PointerEvent<HTMLDivElement>) => {
      if (lassoRef.current.length === 0) return
      const p = toNorm(e.clientX, e.clientY)
      const last = lassoRef.current[lassoRef.current.length - 1]
      // 采样抽稀：相邻点太近就跳过，避免顶点爆炸（掩码精度对此不敏感）
      if (Math.hypot(p.x - last.x, p.y - last.y) < SAMPLE_MIN_DISTANCE) return
      lassoRef.current = [...lassoRef.current, p]
      if (lassoRafRef.current) return
      lassoRafRef.current = requestAnimationFrame(() => {
        lassoRafRef.current = 0
        setLassoPoints(lassoRef.current)
      })
    }

    /**
     * 套索收尾（只处理「完成」）。
     * 中止走 abortDrafting：这里不接受 cancel 事件，避免有人图省事把 cancel 也绑进来。
     */
    const handleLassoUp = (event: React.PointerEvent<HTMLDivElement>) => {
      if (lassoRafRef.current) {
        cancelAnimationFrame(lassoRafRef.current)
        lassoRafRef.current = 0
      }
      const points = lassoRef.current
      const screenStart = pointerStartScreenRef.current
      pointerStartScreenRef.current = null
      lassoRef.current = []
      setLassoPoints([])
      setDrafting(false)
      if (points.length < 8) {
        // 没画成选区一律静默丢弃：阈值只有 10px，失败基本等于误触，
        // 弹错误条会把误触放大成「出错了」。只区分「点一下」＝收起气泡。
        //
        // 判据必须和矩形一致（位移 < 容差），不能看采样点数：采样阈值只有 2px，
        // 手指按下时轻微抖动就能攒出 3~5 个点，按点数判会让「点空白收起」
        // 在套索工具下时灵时不灵——同一手势在不同工具下结果不同，是最难被用户接受的那种不一致。
        const slop = event?.pointerType === 'touch' ? CLICK_SLOP_COARSE : CLICK_SLOP_FINE
        const moved =
          event && screenStart
            ? Math.hypot(event.clientX - screenStart.x, event.clientY - screenStart.y)
            : Number.POSITIVE_INFINITY
        if (moved < slop) collapseActiveBubble()
        return
      }
      const xs = points.map((point) => point.x)
      const ys = points.map((point) => point.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const w = Math.max(...xs) - x
      const h = Math.max(...ys) - y
      const el = wrapperRef.current
      const pxW = w * (el?.clientWidth ?? 1)
      const pxH = h * (el?.clientHeight ?? 1)
      // 面积阈值：太小的一圈多半是误触，落成一个选区反而挡视线（静默丢弃，不弹错）
      if (pxW * pxH < MIN_BOX_PX * MIN_BOX_PX * 2) return
      createRegion({ kind: 'lasso', region: { x, y, w, h }, path: points })
    }

    /**
     * 画笔选区：按下开始记录一笔（固定红色 + 当前粗细）。
     *
     * 松手时只做两件事：
     * 1. 太短的笔迹直接丢弃（误触），不弹错误；
     * 2. 起点落在已有画笔区域内 → 追加进该区域（续画细节），否则新建一个区域。
     */
    const handleBrushDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (submitting) return
      // 画笔经常紧贴着已有区域画，气泡必须让位（只是隐藏，不收起）
      setDrafting(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      const p = toNorm(e.clientX, e.clientY)
      brushStrokeRef.current = {
        points: [p],
        color: BRUSH_COLOR,
        width: Math.max(size, BRUSH_MIN_WIDTH),
        mode: 'draw',
      }
      redrawBrush()
    }

    const handleBrushMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const stroke = brushStrokeRef.current
      if (!stroke) return
      const p = toNorm(e.clientX, e.clientY)
      const last = stroke.points[stroke.points.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) < SAMPLE_MIN_DISTANCE) return
      stroke.points.push(p)
      if (brushRafRef.current) return
      brushRafRef.current = requestAnimationFrame(() => {
        brushRafRef.current = 0
        redrawBrush()
      })
    }

    const handleBrushUp = () => {
      // 先复位「拖拽中」：误触被静默丢弃时气泡也要回来
      setDrafting(false)
      if (brushRafRef.current) {
        cancelAnimationFrame(brushRafRef.current)
        brushRafRef.current = 0
      }
      const stroke = brushStrokeRef.current
      brushStrokeRef.current = null
      if (!stroke) return
      const el = wrapperRef.current
      const boxW = el?.clientWidth ?? 1
      const boxH = el?.clientHeight ?? 1
      const length = strokePixelLength(stroke, boxW, boxH)
      // 点数太少 / 长度不足 = 误触：静默丢弃，不打扰用户
      if (stroke.points.length < 2 || length < MIN_BOX_PX) {
        redrawBrush()
        return
      }
      const bbox = strokesBBox([stroke])
      if (!bbox) {
        redrawBrush()
        return
      }
      const start = stroke.points[0]
      const target = regionsRef.current.find(
        (item) =>
          item.kind === 'brush' &&
          (item.strokes?.length ?? 0) < MAX_BRUSH_STROKES &&
          containsPoint(item.region, start)
      )
      if (target) {
        // 续画：笔迹合并进同一区域，区域数量不变（用户不必为了补细节新建选区）
        setRegions((prev) =>
          prev.map((item) =>
            item.id === target.id
              ? {
                  ...item,
                  strokes: [...(item.strokes ?? []), stroke],
                  region: unionRegion(item.region, bbox),
                }
              : item
          )
        )
        brushHistoryRef.current.push({ regionId: target.id })
        redrawBrush()
        return
      }
      const created = createRegion({ kind: 'brush', region: bbox, strokes: [stroke] })
      if (created) brushHistoryRef.current.push({ regionId: created })
      redrawBrush()
    }

    /** 撤销画笔：删掉最后画进去的一笔；该区域只有这一笔时整区删除。 */
    const handleUndoBrush = () => {
      const history = brushHistoryRef.current
      let target: EditRegion | null = null
      // 从后往前找「区域仍然存在」的那一笔（用户可能已经手动删掉了那个区域）
      while (history.length > 0 && !target) {
        const entry = history[history.length - 1]
        const found = regionsRef.current.find((item) => item.id === entry.regionId)
        if (found) target = found
        else history.pop()
      }
      if (!target) return
      history.pop()
      // 用 const 收窄：下面要在 setRegions 的回调里读它，let 在闭包里会丢失类型收窄
      const current: EditRegion = target
      const strokes = [...(current.strokes ?? [])]
      strokes.pop()
      if (strokes.length === 0) {
        handleDeleteRegion(current.id)
        return
      }
      setRegions((prev) =>
        prev.map((item) => (item.id === current.id ? { ...item, strokes } : item))
      )
    }

    const handlePenDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (submitting) return
      // 标注也隐掉气泡：涂鸦经常画在区域旁边，气泡会挡住落笔点
      setDrafting(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      drawingRef.current = true
      const p = toNorm(e.clientX, e.clientY)
      currentRef.current = {
        points: [p],
        color,
        width: tool === 'eraser' ? size * ERASE_SCALE : size,
        mode: tool === 'eraser' ? 'erase' : 'draw',
      }
      redraw()
    }

    const handlePenMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current || !currentRef.current) return
      currentRef.current.points.push(toNorm(e.clientX, e.clientY))
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        redraw()
      })
    }

    const handlePenUp = () => {
      // 先复位「拖拽中」：即便这一笔被判为误触，气泡也要回来
      setDrafting(false)
      if (!drawingRef.current) return
      drawingRef.current = false
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
      const stroke = currentRef.current
      currentRef.current = null
      if (stroke && stroke.points.length > 1) {
        strokesRef.current.push(stroke)
        redoRef.current = []
        setStrokeCount(strokesRef.current.length)
        setCanRedo(false)
      }
      redraw()
    }

    const handleUndo = () => {
      const stroke = strokesRef.current.pop()
      if (!stroke) return
      redoRef.current.push(stroke)
      setStrokeCount(strokesRef.current.length)
      setCanRedo(true)
      redraw()
    }

    const handleRedo = () => {
      const stroke = redoRef.current.pop()
      if (!stroke) return
      strokesRef.current.push(stroke)
      setStrokeCount(strokesRef.current.length)
      setCanRedo(redoRef.current.length > 0)
      redraw()
    }

    const handleClearStrokes = () => {
      strokesRef.current = []
      redoRef.current = []
      currentRef.current = null
      setStrokeCount(0)
      setCanRedo(false)
      redraw()
    }

    const handleDeleteRegion = (id: string) => {
      setRegions((prev) => prev.filter((item) => item.id !== id))
      // 删掉的正是当前输入目标 → 清空，避免气泡指向一个已不存在的区域
      setActiveRegionId((prev) => (prev === id ? null : prev))
      if (shake?.id === id) setShake(null)
    }

    const handleRegionPromptChange = (id: string, value: string) => {
      setRegions((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item
          // 用户已手动指定过能力 → 完全尊重用户选择
          if (item.handlerTouched) return { ...item, prompt: value }
          // 否则按提示词意图即时纠正（如写「抠出来」→ 自动切到抠图）
          const detected = detectHandler(value, availableHandlers)
          return { ...item, prompt: value, handler: detected ?? item.handler }
        })
      )
    }

    const handleRegionHandlerChange = (id: string, value: string) => {
      setRegions((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, handler: value, handlerTouched: true } : item
        )
      )
    }

    /** 让某个区域的气泡抖一下并聚焦到它的输入框（提交校验失败时的定位手段）。 */
    const shakeAndFocus = (id: string) => {
      shakeTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      // 300ms 内 6 帧左右位移：够醒目，又不至于让人等
      const frames = [-6, 5, -4, 3, -2, 0]
      const step = SHAKE_DURATION / frames.length
      shakeTimersRef.current = frames.map((dx, index) =>
        window.setTimeout(() => {
          setShake(index === frames.length - 1 ? null : { id, dx })
        }, Math.round(index * step))
      )
      focusTargetRef.current = id
      setFocusToken((prev) => prev + 1)
    }

    // 等气泡渲染出来再聚焦（autoFocus 只在首次挂载生效，切区域时需要手动聚焦）
    useEffect(() => {
      const id = focusTargetRef.current
      if (!id) return
      const el = textareaRefs.current[id]
      if (!el) return
      el.focus()
      focusTargetRef.current = null
    }, [focusToken, activeRegionId])

    /**
     * 并集掩码：底板尺寸 = 底图原图尺寸，**透明=可编辑 / 不透明=保留**。
     *
     * 掩码必须「现算」而不是跟着渲染走：选区每动一次都重算一张图会明显掉帧，
     * 而真正需要它的时刻只有提交前这一次。
     */
    const getMaskFile = useCallback(async (): Promise<File | null> => {
      const current = regionsRef.current
      if (current.length === 0) return null
      // 画笔区域的包围盒不参与掩码（否则「画一笔」会变成「挖掉整块矩形」）
      const plainRegions = current
        .filter((item) => item.kind !== 'brush')
        .map((item) => item.region)
      const brushRegions: BrushRegionInput[] = current
        .filter((item) => item.kind === 'brush' && (item.strokes?.length ?? 0) > 0)
        .map((item) => ({ region: item.region, strokes: item.strokes ?? [] }))
      if (plainRegions.length === 0 && brushRegions.length === 0) return null

      let width = naturalWidth || 0
      let height = naturalHeight || 0
      try {
        if (!maskBitmapRef.current && safeSrc) {
          const resp = await fetch(safeSrc)
          const blob = await resp.blob()
          maskBitmapRef.current = await createImageBitmap(blob)
        }
        if (maskBitmapRef.current) {
          width = maskBitmapRef.current.width
          height = maskBitmapRef.current.height
        }
      } catch {
        // 读不到位图时退回 props 的原始尺寸：掩码依然可用，只是分辨率以 props 为准
      }
      if (!(width > 0 && height > 0)) return null

      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width))
        canvas.height = Math.max(1, Math.round(height))
        const ctx = canvas.getContext('2d')
        if (!ctx) return null
        paintUnionMask(ctx, {
          regions: plainRegions,
          brushRegions,
          width: canvas.width,
          height: canvas.height,
        })
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png')
        )
        if (!blob) return null
        return new File([blob], 'edit-mask.png', { type: 'image/png' })
      } catch {
        // 跨域图片会污染 canvas（toBlob 抛错）：返回 null，由调用方回退到几何选区
        return null
      }
    }, [naturalHeight, naturalWidth, safeSrc])

    useImperativeHandle(
      ref,
      () => ({
        getMaskFile,
        hasOpenSurface: () => drafting || activeRegionId !== null,
        collapseActiveSurface: () => {
          // 拖拽中：与 pointercancel 走同一条「中止」路径，气泡与已写内容原样回来
          if (drafting) {
            abortDrafting()
            return
          }
          const id = activeRegionId
          setActiveRegionId(null)
          if (id) requestAnimationFrame(() => chipRefs.current[id]?.focus({ preventScroll: true }))
        },
      }),
      [getMaskFile, activeRegionId, drafting, abortDrafting]
    )

    /** 把这一块的修改需求交给右侧对话面板，由它做 AI 分析并生成 */
  const handleGoCreate = (regionId: string) => {
    const item = regions.find((region) => region.id === regionId)
    if (!item || !item.prompt.trim()) return
    const filled = regions.filter((region) => region.prompt.trim())
    const prompt =
      filled.length > 1
        ? `只修改框选的 ${filled.length} 个区域：${filled
            .map((region, index) => `${index + 1}) ${region.prompt.trim()}`)
            .join('；')}。其余部分保持原样。`
        : `只修改框选区域：${item.prompt.trim()}。其余部分保持原样。`
    setActiveRegionId(null)
    onGoCreate?.({ prompt })
  }

  const handleSubmit = async () => {
      const strokes = strokesRef.current
      if (regions.length === 0 && strokes.length === 0) {
        onError?.('请先在图片上框选区域或涂鸦标注')
        return
      }

      // 校验：带内置提示词的能力（抠图/去物/增强）由平台提示词驱动，无需用户填写
      const missing = regions.filter((r) => needsPrompt(r.handler) && !r.prompt.trim())
      if (missing.length > 0) {
        // 不弹 toast：直接把人送到第一个没写的区域（展开气泡 + 聚焦 + 抖一下），
        // 否则用户只看到一句「还有 N 个没填」，还得自己找是哪几个。
        const target = missing[0]
        setComposerOpen(true)
        setActiveRegionId(target.id)
        shakeAndFocus(target.id)
        return
      }

      // 结构化操作 = 改哪里（region + 可选多边形）+ 怎么改（handler）+ 改成什么（prompt）
      const ops: EditOpPayload[] = regions.map((item) => ({
        region: item.region,
        path: item.path,
        handler: item.handler,
        prompt: item.prompt.trim(),
        intensity: 'fine',
      }))

      // 上游分点指令：**每个区域都要写进去**，包括抠图/挖空这类带内置提示词的能力。
      // 平台不本地处理任何图片，所有区域都必须由 gpt-image-2 执行。
      let finalPrompt = prompt.trim()
      if (ops.length > 0) {
        const lines = ops.map((op, index) => {
          const text = op.prompt.trim() || handlerById[op.handler]?.label || op.handler
          return `【区域${index + 1}】${text}`
        })
        finalPrompt = lines.join('\n')
      }
      if (!finalPrompt && regions.length === 0) {
        onError?.('请先输入修改提示词')
        return
      }

      try {
        const payload = await buildEditPayload({
          dataUrl,
          regions: regions.map((r) => r.region),
          strokes,
          // 每个区域都画红框：上游需要知道「改哪里」，抠图区域同样要标出来
          markIndexes: regions.map((_, index) => index),
          // 画笔区域额外带笔迹：掩码按真实笔画走，而不是整块包围盒
          brushRegions: regions
            .filter((item) => item.kind === 'brush' && (item.strokes?.length ?? 0) > 0)
            .map((item) => ({ region: item.region, strokes: item.strokes ?? [] })),
        })
        // 纯涂鸦没有矩形框时，使用涂鸦包围盒作为唯一的局部修改区域，
        // 这样上游仍然只能改变标注附近，框外像素由后端从原图恢复。
        const finalOps =
          ops.length > 0
            ? ops
            : payload.regions.map((region) => ({
                region,
                handler: 'restyle',
                prompt: finalPrompt,
                intensity: 'fine' as const,
              }))
        onSubmit({ ...payload, ops: finalOps, prompt: finalPrompt })
      } catch {
        // 最常见：跨域图片污染 canvas 导致导出被拒
        onError?.('该图片受跨域限制无法导出，请先「加入画布」后再编辑')
      }
    }

    /**
     * 调用对话模型分析各区域意图，返回「区域序号 → 能力 + 规范化指令」。
     *
     * 这是「用户只负责框选与描述、系统负责理解」的关键一步：
     * 把「说要抠图却按改样式提交」这类误判拦在生成之前。
     */
    const analyzeRegions = useCallback(async () => {
      const described = regions
        .map((item, index) => `区域${index + 1}：${item.prompt.trim() || '（未描述）'}`)
        .join('；')
      return await generateApi.plan({
        message: described,
        regions: regions.map((item, index) => ({ index: index + 1, region: item.region })),
      })
    }, [regions])

    /** 把分析结果回填到各区域（能力 + 规范化指令）。 */
    const applyPlan = useCallback(
      (plan: { ops: Array<{ region_index: number; handler: string; prompt: string }> }) => {
        const byIndex = new Map(plan.ops.map((op) => [op.region_index, op]))
        setRegions((prev) =>
          prev.map((item, index) => {
            const op = byIndex.get(index + 1)
            if (!op) return item
            return {
              ...item,
              handler: op.handler,
              prompt: op.prompt || item.prompt,
              handlerTouched: true,
            }
          })
        )
      },
      []
    )

    /** 「AI 分析」按钮：让对话模型读一遍各区域描述，回填处理方式。 */
    const handleAnalyze = async () => {
      if (regions.length === 0) {
        onError?.('请先在图片上框选区域')
        return
      }
      if (!regions.some((item) => item.prompt.trim())) {
        onError?.('请先给区域写一句需求，再让 AI 分析')
        return
      }
      setAnalyzing(true)
      setThinking(['正在读取选区和用户指令…'])
      try {
        const plan = await analyzeRegions()
        setThinking(plan.thinking ?? ['已完成区域识别', '已规划输出结果'])
        // 服务不可用 / 模型结果全部无效时后端会返回兜底计划（plan_source=fallback）。
        // 此时**绝不能覆盖用户的选择**：否则「手动选了抠图」会被兜底的「改样式」冲掉，
        // 用户还会以为自己看到的是 AI 的理解。
        if (plan.plan_source === 'fallback' || plan.fabricated || plan.demo) {
          onError?.('这次没能可靠理解你的描述，请把每个区域要改什么写得更具体一些')
          return
        }
        if (plan.ops.length === 0) {
          onError?.(plan.reply || 'AI 没能理解需求，请把指令写得更具体一些')
          return
        }
        applyPlan(plan)
        const dropped = plan.dropped_indexes?.length ?? 0
        onNotice?.(
          dropped > 0
            ? `已按理解选择处理方式（有 ${dropped} 个区域没对上，已忽略）`
            : plan.reply || 'AI 分析完成，已按理解选择处理方式'
        )
      } catch {
        onError?.('AI 分析失败，请手动选择每个区域的处理方式')
      } finally {
        setAnalyzing(false)
      }
    }

    /** 画笔笔迹总数：撤销按钮的可用状态与工具条计数都看它 */
    const brushStrokeTotal = useMemo(
      () =>
        regions.reduce(
          (total, item) => total + (item.kind === 'brush' ? item.strokes?.length ?? 0 : 0),
          0
        ),
      [regions]
    )

    /**
     * 是否允许点「生成」。
     *
     * 这里**故意不把「每个区域都填了指令」作为禁用条件**：禁用按钮只会让用户
     * 面对一个点不动的灰按钮，却不知道是哪个区域没写。改成允许点击 → 提交时
     * 定位到第一个缺失的区域（展开 + 聚焦 + 抖动），反馈更直接。
     */
    const canSubmit =
      !submitting &&
      !analyzing &&
      (regions.length > 0 || (prompt.trim().length > 0 && strokeCount > 0))

    /** 已填写指令的区域数：生成按钮上的计数与提示文案都用它 */
    const filledRegionCount = useMemo(
      () => regions.filter((item) => item.prompt.trim().length > 0).length,
      [regions]
    )

    // 产出预估：与后端 estimate_outputs 同规则（整图类合并 1 张；素材类看 per_region）
    const outputPreview = useMemo(() => {
      const groups = new Map<
        string,
        { label: string; kind: 'composite' | 'sprite'; perRegion: boolean; count: number }
      >()
      for (const item of regions) {
        const meta = handlerById[item.handler]
        if (!meta) continue
        const existing = groups.get(meta.id)
        if (existing) existing.count += 1
        else
          groups.set(meta.id, {
            label: meta.label,
            kind: meta.output,
            perRegion: meta.per_region,
            count: 1,
          })
      }
      return Array.from(groups.values())
        .map((group) => ({
          ...group,
          images: group.perRegion ? group.count : 1,
        }))
        .sort((a, b) => (a.kind === 'composite' ? 0 : 1) - (b.kind === 'composite' ? 0 : 1))
    }, [regions, handlerById])

    const outputHint = useMemo(
      () =>
        outputPreview
          .map(
            (group) =>
              `${group.images} 张${group.kind === 'composite' ? '修改图' : '透明素材'}`
          )
          .join(' + '),
      [outputPreview]
    )

    const overlayStyle: React.CSSProperties = useMemo(
      () =>
        imgRect
          ? {
              position: 'absolute',
              left: imgRect.x,
              top: imgRect.y,
              width: imgRect.w,
              height: imgRect.h,
            }
          : {
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: `min(100%, ${Math.min(naturalWidth || 720, 720)}px)`,
              aspectRatio: `${naturalWidth || 1} / ${naturalHeight || 1}`,
            },
      [imgRect, naturalWidth, naturalHeight]
    )

    const composerStyle: React.CSSProperties = useMemo(() => {
      if (!imgRect) {
        return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
      }
      return {
        left: imgRect.x + imgRect.w / 2,
        top: imgRect.y + imgRect.h + 12,
        transform: 'translateX(-50%)',
      }
    }, [imgRect])

    /**
     * 区域气泡布局：贴在该区域包围盒下方 10px，放不下翻到上方；水平夹取避免被裁切；
     * 多气泡共存时**按 top 排序后依次下移**，保证互不遮挡；同时守住两条边界：
     * 顶部不得盖住工具条（最小 top 96），底部不得超出容器（超出则整体上移）。
     * 同一时刻只有 1 个展开（activeRegionId），其余收缩成 chip —— 这是避免
     * 「三个输入框糊在一起」的关键，比让用户自己拖动更可靠。
     */
    const bubbleLayout = useMemo(() => {
      // 与气泡实际宽度一致（w-[300px]）：宽度算错会让碰撞检测失效，chip 又叠在一起
      const W = 300
      const CHIP_H = 30
      const BUBBLE_H = 156
      // chip 触屏热区向四周扩 6px，垂直间距必须 ≥12，否则两个 chip 的热区互相咬住
      const GAP = 12
      const PAD = 8
      const viewH = rootSize.h || 700
      const viewW = rootSize.w || 900

      const entries = regions.map((item) => {
        const active = activeRegionId === item.id
        const height = active ? BUBBLE_H : CHIP_H
        let left = PAD
        let top = BUBBLE_MIN_TOP
        if (imgRect) {
          left = imgRect.x + item.region.x * imgRect.w
          const bottom = imgRect.y + (item.region.y + item.region.h) * imgRect.h
          const topEdge = imgRect.y + item.region.y * imgRect.h
          // 贴框下方 10px；下方放不下就翻到框上方
          top = bottom + 10 + height <= viewH - PAD ? bottom + 10 : topEdge - height - 10
          left = Math.min(Math.max(PAD, left), Math.max(PAD, viewW - W - PAD))
        }
        return { id: item.id, left, top, height }
      })

      // 先按期望位置从上到下排序：结果与「用户看到的上下关系」一致，不会互相插队
      entries.sort((a, b) => a.top - b.top)

      const placed: Array<{ left: number; right: number; top: number; bottom: number }> = []
      const out: Record<string, React.CSSProperties> = {}
      for (const entry of entries) {
        let top = Math.max(BUBBLE_MIN_TOP, entry.top)
        if (top + entry.height > viewH - PAD) {
          top = Math.max(BUBBLE_MIN_TOP, viewH - PAD - entry.height)
        }
        let guard = 0
        while (guard < 12) {
          const hit = placed.find(
            (box) =>
              !(
                entry.left + W < box.left ||
                entry.left > box.right ||
                top + entry.height < box.top ||
                top > box.bottom
              )
          )
          if (!hit) break
          top = hit.bottom + GAP
          guard += 1
        }
        // 被挤下移后可能又冲出底部：兜底上移回容器内
        if (top + entry.height > viewH - PAD) {
          top = Math.max(BUBBLE_MIN_TOP, viewH - PAD - entry.height)
        }
        placed.push({ left: entry.left, right: entry.left + W, top, bottom: top + entry.height })
        out[entry.id] = { left: entry.left, top, width: W }
      }
      return out
    }, [regions, imgRect, rootSize, activeRegionId])

    if (!open) return null

    const regionTool = tool === 'region'
    const lassoTool = tool === 'lasso'
    const brushTool = tool === 'brush'

    return (
      // 根节点不拦截指针：点击图片以外区域仍可落到画布（点空白处即退出编辑）。
      // 但必须在这里吃掉 pointerdown 的**冒泡**：宿主的「单击选中图片即进入编辑」判定
      // 挂在画布容器的 onPointerUpCapture 上，编辑层里的每次按下/抬起都会被当成
      // 「用户在点这张图」→ 再次 enterEdit → state 抖动，最后触发
      // Maximum update depth exceeded。编辑层内部的交互自己处理，不该惊动宿主。
      <div
        ref={rootRef}
        className="pointer-events-none absolute inset-0 z-30"
        onPointerUp={(event) => event.stopPropagation()}
      >
        {/* 图片 + 涂鸦层 + 框选层（精确贴合画布原图，不改变布局） */}
        <div ref={wrapperRef} className="pointer-events-auto overflow-hidden" style={overlayStyle}>
          <img
            ref={imgRef}
            src={safeSrc}
            alt="编辑基准"
            className="absolute inset-0 h-full w-full select-none"
            draggable={false}
          />

          {/* 画笔选区层：半透明红色实心笔迹（不拦截指针，交互由上层 div 接管） */}
          <canvas
            ref={brushCanvasRef}
            className="pointer-events-none absolute inset-0 z-0"
            aria-hidden="true"
          />

          {/* 标注涂鸦层 */}
          <canvas
            ref={canvasRef}
            className={cn(
              'absolute inset-0 z-0 touch-none',
              (regionTool || lassoTool || brushTool) && 'pointer-events-none'
            )}
            style={{
              cursor:
                regionTool || lassoTool || brushTool
                  ? 'crosshair'
                  : tool === 'eraser'
                    ? 'cell'
                    : 'crosshair',
            }}
            onPointerDown={handlePenDown}
            onPointerMove={handlePenMove}
            onPointerUp={handlePenUp}
            onPointerCancel={abortDrafting}
          />

          {/* 选区描边层：矩形与自由多边形统一用 SVG 画，保证套索的真实轮廓可见 */}
          <svg
            className="pointer-events-none absolute inset-0 z-20 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {regions.map((item) => {
              // 画笔选区：笔迹已经由 canvas 层画出来了，这里只补一个虚线包围盒
              if (item.kind === 'brush') {
                return (
                  <rect
                    key={item.id}
                    x={item.region.x * 100}
                    y={item.region.y * 100}
                    width={item.region.w * 100}
                    height={item.region.h * 100}
                    fill="none"
                    stroke="rgba(220, 38, 38, 0.75)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                )
              }
              const common = {
                fill: 'rgba(255, 64, 64, 0.12)',
                stroke: 'rgba(220, 38, 38, 0.95)',
                strokeWidth: 2,
                vectorEffect: 'non-scaling-stroke' as const,
                strokeLinejoin: 'round' as const,
              }
              if (item.path && item.path.length >= 3) {
                return (
                  <polygon
                    key={item.id}
                    points={item.path.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')}
                    {...common}
                  />
                )
              }
              return (
                <rect
                  key={item.id}
                  x={item.region.x * 100}
                  y={item.region.y * 100}
                  width={item.region.w * 100}
                  height={item.region.h * 100}
                  {...common}
                />
              )
            })}
            {draftRect && draftRect.w > 0 && draftRect.h > 0 && (
              <rect
                data-draft-preview="rect"
                x={draftRect.x * 100}
                y={draftRect.y * 100}
                width={draftRect.w * 100}
                height={draftRect.h * 100}
                fill="rgba(255, 64, 64, 0.12)"
                stroke="rgba(255, 32, 32, 0.95)"
                strokeWidth={2}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {lassoPoints.length >= 2 && (
              <polygon
                data-draft-preview="lasso"
                points={lassoPoints.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')}
                fill="rgba(255, 64, 64, 0.10)"
                stroke="rgba(255, 32, 32, 0.95)"
                strokeWidth={2}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            )}
          </svg>

          {/* 编号徽章 + 删除按钮：按包围盒定位，与描边层分离，保证按钮可点 */}
          {regions.map((item, index) => (
            <div
              key={`badge-${item.id}`}
              className="pointer-events-none absolute z-20"
              style={{
                left: `${item.region.x * 100}%`,
                top: `${item.region.y * 100}%`,
                width: `${item.region.w * 100}%`,
                height: `${item.region.h * 100}%`,
              }}
            >
              <button
                type="button"
                title="编辑该区域的说明"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setActiveRegionId(item.id)}
                className="pointer-events-auto absolute -left-2.5 -top-2.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-[rgba(220,38,38,0.98)] text-[11px] font-bold text-white shadow transition-transform hover:scale-110"
              >
                {index + 1}
              </button>
              <button
                type="button"
                title="删除该选区"
                className="pointer-events-auto absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full border border-white bg-black/70 text-white hover:bg-danger"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => handleDeleteRegion(item.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}

          {/* 框选交互层（仅框选工具激活时接管指针；层级低于标记框，保证删除按钮可点） */}
          {regionTool && (
            <div
              className="absolute inset-0 z-10 touch-none"
              style={{ cursor: 'crosshair' }}
              onPointerDown={handleRegionDown}
              onPointerMove={handleRegionMove}
              onPointerUp={handleRegionUp}
              // 指针被打断时只复位状态、不落选区：drafting 不复位会让气泡永远不出现
              onPointerCancel={abortDrafting}
            />
          )}

          {/* 自由选区（套索）交互层：按住画一圈，松手闭合成多边形 */}
          {lassoTool && (
            <div
              className="absolute inset-0 z-10 touch-none"
              style={{ cursor: 'crosshair' }}
              onPointerDown={handleLassoDown}
              onPointerMove={handleLassoMove}
              onPointerUp={handleLassoUp}
              // cancel 不传事件：系统打断不是「点空白」，不能顺手把气泡收掉
              onPointerCancel={abortDrafting}
            />
          )}

          {/* 画笔自由选区交互层：像涂鸦一样画，松手即成为一个选区 */}
          {brushTool && (
            <div
              className="absolute inset-0 z-10 touch-none"
              style={{ cursor: 'crosshair' }}
              onPointerDown={handleBrushDown}
              onPointerMove={handleBrushMove}
              onPointerUp={handleBrushUp}
              onPointerCancel={abortDrafting}
            />
          )}
        </div>

        {/* 顶部工具条：下移避开 Excalidraw 原生工具条（避免两条工具栏重叠） */}
        <div className="pointer-events-auto absolute left-1/2 top-14 z-20 mt-2 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-full border border-border bg-surface/95 px-2.5 py-1.5 shadow-md backdrop-blur">
          <div className="flex items-center gap-0.5">
            <ToolButton
              active={regionTool}
              icon={<Frame size={12} />}
              label="框选"
              onClick={() => setTool('region')}
            />
            <ToolButton
              active={lassoTool}
              icon={<Lasso size={12} />}
              label="套索"
              onClick={() => setTool('lasso')}
            />
            <ToolButton
              active={brushTool}
              icon={<Brush size={12} />}
              label="画笔"
              title="画笔选区：按住涂抹，松手即成为可填写指令的区域"
              onClick={() => setTool('brush')}
            />
            <ToolButton
              active={tool === 'pen'}
              icon={<PenLine size={12} />}
              label="标注"
              title="涂鸦标注：只是给上游的视觉提示，不构成选区"
              onClick={() => setTool('pen')}
            />
            <ToolButton
              active={tool === 'eraser'}
              icon={<Eraser size={12} />}
              label="橡皮"
              title="擦除标注（只作用于标注笔迹，不影响画笔选区）"
              onClick={() => setTool('eraser')}
            />
          </div>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <div className={cn('flex items-center gap-0.5', regionTool && 'opacity-40')}>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                onClick={() => {
                  setColor(c)
                  setTool('pen')
                }}
                className={cn(
                  'h-5 w-5 rounded-full border transition-transform',
                  color === c && !regionTool ? 'scale-110 border-brand ring-2 ring-brand/40' : 'border-border'
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <div className={cn('flex items-center gap-0.5', regionTool && 'opacity-40')}>
            {SIZES.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setSize(s.value)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  size === s.value ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:bg-surface-hover'
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
          <span className="mx-0.5 h-4 w-px bg-border" />
          <div className="flex items-center gap-0.5">
            <IconButton disabled={!strokeCount} title="撤销标注" onClick={handleUndo}>
              <RotateCcw size={12} />
            </IconButton>
            <IconButton disabled={!canRedo} title="重做标注" onClick={handleRedo}>
              <Redo2 size={12} />
            </IconButton>
            <IconButton disabled={!strokeCount} title="清空标注" onClick={handleClearStrokes}>
              <Eraser size={12} />
            </IconButton>
            <IconButton
              disabled={brushStrokeTotal === 0}
              title="撤销画笔（删除最后画的一笔）"
              onClick={handleUndoBrush}
            >
              <Undo2 size={12} />
            </IconButton>
          </div>
          <span className="whitespace-nowrap rounded-full bg-bg-subtle px-2 py-0.5 text-[11px] text-text-secondary">
            {regions.length} 区域 · {strokeCount} 标注
            {brushStrokeTotal > 0 ? ` · ${brushStrokeTotal} 画笔` : ''}
          </span>
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="删除这张图片"
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-danger-subtle hover:text-danger"
            >
              <Trash2 size={12} /> 删除
            </button>
          )}

          {/* 主操作：直接提交给 AI 生成。
              ⚠️ 这个按钮曾经缺失：提交逻辑（handleSubmit → onSubmit → 生成链路）一直在，
              但界面上没有任何入口调用它，用户写完批注后只能「完成」退出，
              于是出现「写了提示词却没提交给 AI」的情况。
              现在按「有内容才可用」呈现，未填指令时点击会定位到第一个空区域。 */}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || submitting}
            aria-label={
              regions.length === 0 && strokeCount === 0
                ? '先框选要修改的区域'
                : `生成：这张图上有 ${regions.length} 个选区、已填 ${filledRegionCount} 个说明`
            }
            title={
              regions.length === 0 && strokeCount === 0
                ? '先框选要修改的区域'
                : `提交 ${filledRegionCount} 个区域给 AI 生成`
            }
            className={cn(
              'relative inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all',
              'bg-brand text-text-inverse hover:brightness-110 active:scale-[0.97]',
              'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100'
            )}
          >
            {/* 「这张图上有未提交的选区」的持久指示：切走再切回来还在，
                用青柠（唯一信号色）而不是加文案，避免工具条再长一截 */}
            {regions.length > 0 && !submitting && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-surface"
              />
            )}
            {submitting ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {submitting ? '生成中' : '生成'}
            {!submitting && filledRegionCount > 0 && (
              <span className="rounded-full bg-white/20 px-1 tabular-nums">{filledRegionCount}</span>
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            title="退出编辑（已框选的内容会自动保留）"
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-surface-hover"
          >
            <X size={12} /> 完成
          </button>
        </div>

        {/* 区域就地输入气泡：框完就在框旁边写，不用跑到画布底部 */}
        {regions.map((item, index) => {
          const active = activeRegionId === item.id
          const baseStyle = bubbleLayout[item.id] ?? { left: 8, top: 8, width: 300 }
          // 校验失败时只抖这个区域的气泡：位移用内联 transform，不引入新依赖
          const offset = shake?.id === item.id ? shake.dx : 0
          const style: React.CSSProperties = offset
            ? { ...baseStyle, transform: `translateX(${offset}px)` }
            : baseStyle
          // 拖拽画选区期间整体隐掉：保留 DOM（不卸载 → 光标/组词状态不丢），只关交互与可见性。
          //
          // 已知代价（刻意接受，不是遗漏）：
          // 1. 现象：拖拽期间 textarea 仍持有焦点，此时敲键盘会写进「看不见的」那个区域输入框。
          // 2. 为什么不 blur：拖动中 blur 会触发组词提交与焦点链变化，松手后还得把焦点和光标
          //    复原回去，代价大于收益；拖拽本身是纯指针动作，正常不会同时打字。
          // 3. 何时重新评估：出现「拖拽时误触键盘」的真实反馈，或产品要求「拖拽中继续输入」。
          // 4. 现在怎么测：拖拽期间不敲键盘，只在拖拽前后校验 textarea 值与区域数
          //    （e2e/edit_ux_verify.mjs 的用例 5）。
          //
          // 隐藏必须 `transition-none`：motion.css 的 base 层给所有 button 加了 opacity 过渡，
          // 不显式关掉的话按下后还会淡出 160ms —— 那 160ms 里 chip 正好盖在正在画的框上，
          // 「遮挡」这条需求等于只修了一半。恢复走 160ms 淡入。
          const suppress = drafting
            ? 'pointer-events-none opacity-0 transition-none'
            : 'pointer-events-auto opacity-100 transition-[color,border-color,opacity] duration-[var(--motion-fast)] ease-[var(--ease-out)]'
          if (!active) {
            // 未激活也保留一个 chip：用户随时能看到「这个区域还没写说明」
            return (
              <button
                key={`chip-${item.id}`}
                ref={(el) => {
                  chipRefs.current[item.id] = el
                }}
                type="button"
                data-edit-surface="chip"
                aria-expanded={false}
                aria-label={
                  item.prompt.trim()
                    ? `区域 ${index + 1}：${item.prompt.trim()}，点击继续编辑`
                    : `区域 ${index + 1}：还没有填写说明，点击填写`
                }
                onClick={() => setActiveRegionId(item.id)}
                style={style}
                title="点击填写该区域的说明"
                className={cn(
                  'absolute z-40 flex h-[30px] items-center gap-1.5 rounded-full border bg-surface-raised px-2 py-1 text-[11px] shadow-sheet hover:border-brand hover:text-brand-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  // 触屏热区扩到 42px 高（视觉仍是 30px，不改布局）：chip 是重新打开输入的唯一入口
                  'pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-inset-y-[6px] pointer-coarse:before:content-[\'\']',
                  suppress,
                  item.prompt.trim()
                    ? 'border-border text-text-secondary'
                    : 'border-danger/50 text-danger'
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[rgba(220,38,38,0.95)] text-[9px] font-bold text-white">
                  {index + 1}
                </span>
                <span className="max-w-[190px] min-w-0 truncate">
                  {item.prompt.trim() || '填写说明'}
                </span>
              </button>
            )
          }
          return (
            <div
              key={`bubble-${item.id}`}
              ref={bubbleRef}
              data-edit-surface="bubble"
              role="group"
              aria-label={`区域 ${index + 1} 的修改说明`}
              style={style}
              onPointerDown={(event) => event.stopPropagation()}
              className={cn(
                // 亮色下靠投影浮起，不描边（纸的层次靠明度差 + 阴影，不靠 1px 线）
                'cs-edit-bubble absolute z-40 w-[300px] rounded-[16px] bg-surface-raised p-2.5',
                'cs-edit-bubble-in',
                suppress
              )}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-text">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[rgba(220,38,38,0.95)] text-[9px] font-bold text-white">
                    {index + 1}
                  </span>
                  区域 {index + 1}
                </span>
                <div className="flex items-center gap-0.5">
                  {/* 润色：只改这段描述，不碰画布上的框 */}
                  <PolishPopover
                    variant="icon"
                    text={item.prompt}
                    scene="region"
                    onApply={(next) => handleRegionPromptChange(item.id, next)}
                    disabled={!item.prompt.trim()}
                  />
                  <button
                    type="button"
                    onClick={() => setActiveRegionId(null)}
                    className="rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    aria-label="完成该区域"
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
              <textarea
                ref={(el) => {
                  textareaRefs.current[item.id] = el
                  // 随内容自动增高：先归零再按 scrollHeight 设，避免只增不减
                  if (el) {
                    el.style.height = 'auto'
                    el.style.height = `${Math.min(180, Math.max(52, el.scrollHeight))}px`
                  }
                }}
                autoFocus
                rows={1}
                value={item.prompt}
                onChange={(event) => {
                  handleRegionPromptChange(item.id, event.target.value)
                  const el = event.currentTarget
                  el.style.height = 'auto'
                  el.style.height = `${Math.min(180, Math.max(52, el.scrollHeight))}px`
                }}
                onCompositionStart={() => {
                  composingRef.current = true
                }}
                onCompositionEnd={() => {
                  composingRef.current = false
                }}
                onKeyDown={(event) => {
                  // 输入法组词中的回车是选词，不是确认
                  if (event.nativeEvent.isComposing || composingRef.current) return
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    setActiveRegionId(null)
                  }
                  // Esc 不在这里处理：收起气泡还是退出编辑，统一由宿主按「有没有展开气泡」裁决
                }}
                placeholder="描述这一块要怎么改…"
                className="w-full resize-none rounded-[10px] bg-bg-subtle px-2.5 py-2 text-[12px] leading-relaxed text-text placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand/40"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="shrink-0 text-[10px] text-text-faint">
                  {/* 快捷键只在桌面端有意义；触屏给「点图片收起」（图内空白=收起，图外=退出） */}
                  <span className="pointer-coarse:hidden">Enter 完成 · Shift+Enter 换行</span>
                  <span className="hidden pointer-coarse:inline">点图片收起</span>
                </span>
                {/* 字数可牺牲：空间不足时先丢它，绝不截断快捷键提示 */}
                {item.prompt.trim().length >= 80 && (
                  <span className="min-w-0 truncate text-[10px] tabular-nums text-text-faint">
                    {item.prompt.trim().length} 字
                  </span>
                )}
                <button
                  type="button"
                  disabled={!item.prompt.trim() || submitting || analyzing}
                  onClick={() => handleGoCreate(item.id)}
                  className="ml-auto inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 text-[11px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  <Sparkles size={11} /> 去创作
                </button>
              </div>
            </div>
          )

        })}


        {/* 只保留一个状态条：输入已经全部收进选区气泡，底部不再重复放输入框 */}
        {(analyzing || submitting) && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-[11px] text-text-secondary shadow-sheet">
            <Loader2 size={12} className="animate-spin" />
            {analyzing ? '正在分析需求…' : '正在提交…'}
          </div>
        )}
      </div>
    )
  }
)

function ToolButton({
  active,
  icon,
  label,
  title,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  /** 悬停提示；缺省与文案一致 */
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors',
        active ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:text-text-secondary'
      )}
    >
      {icon} {label}
    </button>
  )
}

function IconButton({
  disabled,
  title,
  onClick,
  children,
}: {
  disabled?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:opacity-40"
    >
      {children}
    </button>
  )
}
