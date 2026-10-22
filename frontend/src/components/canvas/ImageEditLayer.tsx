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
  Check,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
  ANNOTATION_LABEL_MAX,
  annotationStats,
  annotationsBBox,
  createBorderAnnotation,
  createMarkerAnnotation,
  nextAnnotationIndex,
  translateAnnotation,
  type AnnotationObject,
  type Box,
  type Pt,
} from './annotations'
import {
  AnnotationHistory,
  applyPayloadTo,
  findPayload,
  type HistoryDirection,
  type HistoryOp,
  type OpPayload,
} from './annotation-history'
import { AnnotationLayer } from './AnnotationLayer'
import { EditToolbar, type EditTool } from './edit/EditToolbar'
import { RegionOverlay, type RegionTransformMode } from './edit/RegionOverlay'
import { EditCoach } from './edit/EditCoach'
import {
  handleEdges,
  resizeRegion,
  snapRegion,
  translateRegion,
  type ResizeHandle,
  type SnapGuide,
} from './edit/region-geometry'
import './edit/edit.css'
import {
  editDraftKey,
  markRestoreNotified,
  readEditDraft,
  writeEditDraft,
  type EditRegion,
  type RegionKind,
} from './edit-draft'

/**
 * 工具集合（R15：7 个工具分 3 组）。
 *
 * **选区组**（产出「选区 + 指令」，会进掩码）
 * - `region` / `lasso`：矩形框选 / 自由套索；
 * - `brush`：画笔自由选区——像涂鸦一样画，松手即成为一个可填指令的选区，
 *   同一区域可以反复续画细节（笔迹合并、区域不增加）。
 *
 * **标注组**（只做视觉提示，**不产生选区、不进掩码、不弹指令气泡**）
 * - `pen`：标注涂鸦；
 * - `border`：矩形 / 椭圆描边（R07）；
 * - `marker`：箭头 / 序号 / 文字标签（R08）。
 *
 * **擦除组**
 * - `eraser`：只擦标注笔迹，**不影响画笔选区**。
 */
type Tool = EditTool

/** 工具快捷键（R15：每个工具的 tooltip 都要带它） */
const TOOL_SHORTCUTS: Record<Tool, string> = {
  region: 'R',
  lasso: 'L',
  brush: 'B',
  pen: 'P',
  border: 'F',
  marker: 'M',
  eraser: 'E',
}


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
    output: 'composite',
    per_region: false,
    billable: true,
    has_builtin_prompt: false,
  },
  {
    id: 'cutout',
    label: '抠图',
    description: '',
    output: 'sprite',
    per_region: true,
    billable: true,
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
    /**
     * 标注计数（R09）：`{"border":2,"marker":3,"doodle":1}` 的 JSON 字符串。
     * 后端只写日志、不入库——标注在提交时已合成进 guideFile，原对象没有复用价值。
     */
    annotation_stats?: string
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
    const { t } = useTranslation('edit')
    const [tool, setTool] = useState<Tool>('region')
    const [color, setColor] = useState(COLORS[0])
    const [size, setSize] = useState(SIZES[1].value)
    const [regions, setRegions] = useState<EditRegion[]>([])
    /** 标注对象（边框 / 标记）：**不进 regions**，不产出选区（PRD D3） */
    const [annotations, setAnnotations] = useState<AnnotationObject[]>([])
    /** 统一编号器（R08）：序号标注的下一可用号，删除不回收 */
    const [annotationSeq, setAnnotationSeq] = useState(1)
    /** R19 显隐开关：隐藏时数据保留，恢复后原位重现 */
    const [annotationVisible, setAnnotationVisible] = useState(true)
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
    /** 边框子选项（矩形 / 椭圆 + 实线 / 虚线） */
    const [borderShape, setBorderShape] = useState<'rect' | 'ellipse'>('rect')
    const [borderDash, setBorderDash] = useState<'solid' | 'dashed'>('solid')
    /** 标记子选项（箭头 / 序号 / 文字） */
    const [markerShape, setMarkerShape] = useState<'arrow' | 'index' | 'label'>('arrow')
    /** 文字标签的就地输入（未确认前不落对象：否则会出现空标签） */
    const [labelDraft, setLabelDraft] = useState<{ x: number; y: number; text: string } | null>(null)
    const [draftRect, setDraftRect] = useState<NormRegion | null>(null)
    /** 套索正在绘制的顶点（归一化） */
    const [lassoPoints, setLassoPoints] = useState<Array<{ x: number; y: number }>>([])
    const [strokeCount, setStrokeCount] = useState(0)
    /** 撤销栈变化计数器：栈本身在 ref 里（避免每次 commit 都重建对象），靠它触发按钮重算 */
    const [historyTick, setHistoryTick] = useState(0)
    const [safeSrc, setSafeSrc] = useState('')
    const [boxSize, setBoxSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
    const [analyzing, setAnalyzing] = useState(false)
    const [composerOpen, setComposerOpen] = useState(true)
    const [thinking, setThinking] = useState<string[]>([])
    /** 当前正在就地输入的区域（框选后自动聚焦到该区域的气泡） */
    const [activeRegionId, setActiveRegionId] = useState<string | null>(null)
    /** 指针悬停的选区（来自徽章 / 把手 / chip）：描边加粗 + 显出删除键与把手 */
    const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null)
    /** 正在被拖动 / 缩放的选区 */
    const [transformingId, setTransformingId] = useState<string | null>(null)
    /** 吸附参考线（拖动 / 缩放时命中的对齐位置） */
    const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([])
    /** 「重画」后让工具条上当前工具闪一下 */
    const [toolPulse, setToolPulse] = useState(0)
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
    /** 选区拖动/缩放的起点快照：位移始终相对它计算，merge 成「一次拖拽 = 一步撤销」 */
    const regionDragRef = useRef<{ id: string; before: OpPayload<EditRegion> } | null>(null)
    /**
     * 气泡打开那一刻的说明文字：「取消」据此还原。
     * `fresh` = 这个选区是刚画出来的——取消它就等于「不要这个框了」，直接删掉（可 ⌘Z 找回）。
     */
    const bubbleSnapshotRef = useRef<{ id: string; prompt: string; fresh: boolean } | null>(null)
    /** 画笔/涂鸦/橡皮的光标预览圈：逐帧改 DOM，不走 React 状态（否则每次移动都重渲染整层） */
    const brushCursorRef = useRef<HTMLSpanElement>(null)
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
        return !item.has_builtin_prompt
      },
      [handlerById]
    )

    const wrapperRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    /** 画笔选区显示层：与标注涂鸦分层，互不覆盖 */
    const brushCanvasRef = useRef<HTMLCanvasElement>(null)
    const imgRef = useRef<HTMLImageElement>(null)
    const strokesRef = useRef<DoodleStroke[]>([])
    const currentRef = useRef<DoodleStroke | null>(null)
    const drawingRef = useRef(false)
    /** 画笔当前正在画的一笔 */
    const brushStrokeRef = useRef<DoodleStroke | null>(null)
    /** 选区状态镜像：指针事件回调里需要读到最新值，避免闭包拿到旧数组 */
    const regionsRef = useRef<EditRegion[]>([])
    /** 标注状态镜像（同上：拖拽回调里必须读到最新值） */
    const annotationsRef = useRef<AnnotationObject[]>([])
    /** 编号器镜像：序号标注在同一帧内连点两次也要拿到不同的号 */
    const annotationSeqRef = useRef(1)
    /** 显隐开关镜像：`redraw` 是稳定回调（依赖为空），只能通过 ref 读到最新开关 */
    const annotationVisibleRef = useRef(true)
    /** 边框绘制起点（归一化） */
    const borderStartRef = useRef<Pt | null>(null)
    /** 标记绘制起点（归一化） */
    const markerStartRef = useRef<Pt | null>(null)
    /** 正在拖动某个标注：`before` 是拖动开始前的对象快照（撤销栈的 move 载荷） */
    const annotationDragRef = useRef<{ id: string; before: OpPayload<AnnotationObject> } | null>(null)
    /** 统一撤销栈（R17）：标注 / 选区 / 笔迹共用一条 */
    const historyRef = useRef<AnnotationHistory | null>(null)
    /** 栈的应用回调走 ref：栈在首次渲染时创建，那时还没有闭包依赖问题 */
    const applyHistoryOpRef = useRef<(op: HistoryOp, direction: HistoryDirection) => void>(() => {})
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

    /**
     * 三个集合的统一写入器。
     * 先同步 ref 再 setState：指针回调里读的是 ref（闭包里的 state 是旧的），
     * 两步必须在同一个函数里做，否则「刚加的对象马上拖动」会读到空数组。
     */
    const writeAnnotations = useCallback((next: AnnotationObject[]) => {
      annotationsRef.current = next
      setAnnotations(next)
    }, [])
    const writeRegions = useCallback((next: EditRegion[]) => {
      regionsRef.current = next
      setRegions(next)
    }, [])
    const writeStrokes = useCallback((next: DoodleStroke[]) => {
      strokesRef.current = next
      setStrokeCount(next.length)
    }, [])

    /**
     * 撤销栈的**唯一落地处**：`undo` 用 `before` 还原，`redo`（含新变更）用 `after` 落地。
     *
     * - `annotation` / `region` 有 id → 按 id upsert（`applyPayloadTo`）；
     * - `stroke` 没有 id → 按**对象引用**定位。笔迹对象从头到尾是同一个引用，
     *   引用相等比下标更抗「跨目标撤销导致的顺序漂移」。
     */
    const applyHistoryOp = useCallback(
      (op: HistoryOp, direction: HistoryDirection) => {
        const target = direction === 'undo' ? op.before : op.after
        if (op.target === 'annotation') {
          writeAnnotations(
            applyPayloadTo(
              annotationsRef.current,
              op.id,
              target as OpPayload<AnnotationObject> | undefined,
              (value) => value.id
            )
          )
          // 被撤销掉的标注不能继续处于「选中」状态（否则删除按钮指向空对象）
          setSelectedAnnotationId((prev) =>
            prev && prev === op.id && !target ? null : prev
          )
          return
        }
        if (op.target === 'region') {
          const next = applyPayloadTo(
            regionsRef.current,
            op.id,
            target as OpPayload<EditRegion> | undefined,
            (value) => value.id
          )
          writeRegions(next)
          // 当前输入气泡指向的区域被撤销掉时必须收起来，否则气泡指向不存在的区域
          setActiveRegionId((prev) => (prev && !next.some((item) => item.id === prev) ? null : prev))
          return
        }
        const current = strokesRef.current
        const from = direction === 'undo' ? op.after : op.before
        if (!target) {
          const at = from ? current.indexOf(from.value as DoodleStroke) : -1
          writeStrokes(at >= 0 ? [...current.slice(0, at), ...current.slice(at + 1)] : current)
          return
        }
        const index = Math.max(0, Math.min(target.index, current.length))
        writeStrokes([
          ...current.slice(0, index),
          target.value as DoodleStroke,
          ...current.slice(index),
        ])
      },
      [writeAnnotations, writeRegions, writeStrokes]
    )
    applyHistoryOpRef.current = applyHistoryOp

    if (!historyRef.current) {
      historyRef.current = new AnnotationHistory({
        onApply: (op, direction) => {
          applyHistoryOpRef.current(op, direction)
          // 栈内容变了：触发按钮的可用状态重算
          setHistoryTick((tick) => tick + 1)
        },
      })
    }
    const history = historyRef.current

    /** 记录一次变更并**立即应用**——所有增删改的唯一入口（禁止绕过它直接 setState） */
    const commit = useCallback(
      (op: HistoryOp, options?: { merge?: boolean }) => {
        history.commit(op, options)
      },
      [history]
    )
    const undo = useCallback(() => {
      history.undo()
    }, [history])
    const redo = useCallback(() => {
      history.redo()
    }, [history])
    // historyTick 是「栈内容」的版本号：栈本身不可变引用，靠它触发重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const canUndo = useMemo(() => history.canUndo(), [history, historyTick])
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const canRedo = useMemo(() => history.canRedo(), [history, historyTick])

    useEffect(() => {
      regionsRef.current = regions
    }, [regions])

    useEffect(() => {
      annotationsRef.current = annotations
    }, [annotations])

    useEffect(() => {
      annotationSeqRef.current = annotationSeq
    }, [annotationSeq])

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
      const nextAnnotations = draft?.annotations ?? []
      setRegions(nextRegions)
      regionsRef.current = nextRegions
      strokesRef.current = nextStrokes
      annotationsRef.current = nextAnnotations
      setAnnotations(nextAnnotations)
      /**
       * 编号器初值 = `regions.length + 1`（R08 统一编号器：区域永远 1..n，标注永远 n+1..）。
       * 草稿里存了更靠后的号时取更大的那个——删除不回收号码，回退会让「第 3 处」变回「第 2 处」。
       */
      const nextSeq = Math.max(draft?.annotationSeq ?? 1, nextRegions.length + 1)
      annotationSeqRef.current = nextSeq
      setAnnotationSeq(nextSeq)
      setAnnotationVisible(true)
      setSelectedAnnotationId(null)
      setLabelDraft(null)
      setBorderShape('rect')
      setBorderDash('solid')
      setMarkerShape('arrow')
      /**
       * 切图必须清空撤销栈：A 图的 op 拿到 B 图上执行（同 id 恰好撞上或插到 B 的位置）
       * 是最难排查的一类数据错乱，宁可从零开始。
       */
      historyRef.current?.clear()
      setHistoryTick((tick) => tick + 1)
      setStrokeCount(nextStrokes.length)
      setDraftRect(null)
      setLassoPoints([])
      lassoRef.current = []
      setTool('region')
      currentRef.current = null
      brushStrokeRef.current = null
      drawingRef.current = false
      regionStartRef.current = null
      borderStartRef.current = null
      markerStartRef.current = null
      annotationDragRef.current = null
      setComposerOpen(true)
      setThinking([])
      setActiveRegionId(null)
      setShake(null)
      setDrafting(false)
      hydratedKeyRef.current = key
      // 同一张图每次会话只提示一次「已恢复」，反复进出不刷屏
      const restoredTotal = nextRegions.length + nextAnnotations.length + nextStrokes.length
      if (restoredTotal > 0 && markRestoreNotified(key)) {
        noticeRef.current?.(
          nextRegions.length > 0
            ? `已恢复上次的 ${nextRegions.length} 个选区`
            : `已恢复上次的 ${nextAnnotations.length + nextStrokes.length} 处标注`
        )
      }
      // 依赖里只放 open / draftKey：onNotice 是内联函数，放进依赖会导致每次渲染都重置
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, draftKey])

    /**
     * 草稿落盘：选区 / 每区提示词 / 涂鸦 / 标注 / 编号器一变就写回。
     *
     * 守卫 `regionsRef.current !== regions` 很关键：切图那一帧，`regions` 还是上一张图的
     * 旧数组，而水合刚把 regionsRef 换成新图的——此时写回会把 A 图的选区灌进 B 图的草稿。
     * `annotations` 同理（它比选区更容易漏，因为它是后加的）。
     */
    useEffect(() => {
      if (!open) return
      const key = draftKey ?? null
      if (!key) return
      if (hydratedKeyRef.current !== key) return
      if (regionsRef.current !== regions) return
      if (annotationsRef.current !== annotations) return
      writeEditDraft(key, {
        regions,
        strokes: strokesRef.current,
        annotations,
        annotationSeq,
      })
    }, [regions, strokeCount, annotations, annotationSeq, open, draftKey])

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
      // R19：显隐开关关掉时涂鸦也不画（数据仍保留在 strokesRef 里，打开即原位重现）
      if (!annotationVisibleRef.current) return
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
      // 边框 / 标记 / 文字标签 / 标注拖动：全部在同一个入口复位
      // （Esc 与 pointercancel 必须完全等价，否则「按 Esc 没事、来电却多出个框」这类
      //   只在特定设备复现的差异会一直存在）
      borderStartRef.current = null
      markerStartRef.current = null
      annotationDragRef.current = null
      setLabelDraft(null)
      setDraftRect(null)
      setLassoPoints([])
      setDrafting(false)
      // 重绘两层：把「正在画的那一笔」从画面上抹掉。套索/边框/标记由 SVG 层按 state 渲染，
      // 这两次重绘对它们是空操作——统一调用比按工具分支更不容易漏。
      redraw()
      redrawBrush()
    }, [redraw, redrawBrush])

    // 选区变化后重画画笔层（增删区域、续画、撤销都走这条路）
    useEffect(() => {
      redrawBrush()
    }, [regions, redrawBrush])

    // R19 显隐开关：涂鸦画在 canvas 上，必须显式重绘；SVG 标注层由 props 驱动，天然响应
    useEffect(() => {
      annotationVisibleRef.current = annotationVisible
      redraw()
    }, [annotationVisible, redraw])

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

    // 任何途径打开了别的区域（撤销、提交校验定位…）：快照跟着换，「取消」才不会还原错对象
    useEffect(() => {
      if (!activeRegionId) return
      if (bubbleSnapshotRef.current?.id === activeRegionId) return
      const item = regionsRef.current.find((region) => region.id === activeRegionId)
      bubbleSnapshotRef.current = { id: activeRegionId, prompt: item?.prompt ?? '', fresh: false }
    }, [activeRegionId])

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
      const created: EditRegion = {
        id: newId,
        kind: params.kind,
        handler: defaultHandlerId,
        prompt: '',
        region: params.region,
        path: params.path,
        strokes: params.strokes,
      }
      // 走撤销栈（R17）：框选 / 套索 / 画笔的新增同样要能 Ctrl+Z 退回
      commit({
        type: 'add',
        target: 'region',
        id: newId,
        after: { index: regionsRef.current.length, value: created },
      })
      // 画完就地把输入气泡弹在这个区域旁边，用户不用再跑去底部输入
      bubbleSnapshotRef.current = { id: newId, prompt: '', fresh: true }
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
        const index = regionsRef.current.findIndex((item) => item.id === target.id)
        const nextRegion: EditRegion = {
          ...target,
          strokes: [...(target.strokes ?? []), stroke],
          region: unionRegion(target.region, bbox),
        }
        // 「续画」= 区域对象的前后态变化，用 move op 记录（撤销一次退回一笔，而不是整个区域消失）
        commit({
          type: 'move',
          target: 'region',
          id: target.id,
          before: { index: Math.max(0, index), value: target },
          after: { index: Math.max(0, index), value: nextRegion },
        })
        redrawBrush()
        return
      }
      createRegion({ kind: 'brush', region: bbox, strokes: [stroke] })
      redrawBrush()
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
        // 涂鸦（含橡皮笔迹）进统一撤销栈：R17 要求 7 个工具都能撤销
        commit({
          type: 'add',
          target: 'stroke',
          id: crypto.randomUUID(),
          after: { index: strokesRef.current.length, value: stroke },
        })
      }
      redraw()
    }

    /** 撤销：走统一栈（标注 / 选区 / 笔迹共用），不再只回退笔迹 */
    const handleUndo = () => {
      undo()
      redraw()
      redrawBrush()
    }

    /** 重做：`after` 重放，天然不会产生重复对象（R17） */
    const handleRedo = () => {
      redo()
      redraw()
      redrawBrush()
    }

    /** 清空全部涂鸦笔迹：逐笔进栈，用户后悔时能一步步退回来 */
    const handleClearStrokes = () => {
      const strokes = [...strokesRef.current]
      if (strokes.length === 0) return
      strokes.forEach((stroke, index) => {
        commit({
          type: 'remove',
          target: 'stroke',
          id: crypto.randomUUID(),
          before: { index, value: stroke },
        })
      })
      currentRef.current = null
      redraw()
    }

    /**
     * 撤销画笔：只回退「最后一笔画笔笔迹」。
     *
     * 与 `handleUndo`（统一撤销栈，一次退掉任意一个对象）是两种粒度：
     * 涂鸦可能在一个区域里续画几十笔，用户想退掉刚画错的那一笔时，
     * 走统一栈会把整个对象退掉，太粗暴。
     *
     * 笔迹存在 brush 区域的 `strokes` 里（见 handleBrushUp 的续画分支），
     * 所以这里对**最后一个非空 brush 区域**做前后态变更，同样进栈，Ctrl+Z 仍能找回。
     */
    const handleUndoBrush = () => {
      const items = regionsRef.current
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const region = items[index]
        const strokes = region.strokes ?? []
        if (region.kind !== 'brush' || strokes.length === 0) continue
        if (strokes.length === 1) {
          // 删掉这一笔区域就空了 → 整个区域一起撤掉，避免留下空选区
          commit({
            type: 'remove',
            target: 'region',
            id: region.id,
            before: { index, value: region },
          })
        } else {
          commit({
            type: 'move',
            target: 'region',
            id: region.id,
            before: { index, value: region },
            after: { index, value: { ...region, strokes: strokes.slice(0, -1) } },
          })
        }
        redrawBrush()
        return
      }
    }

    /**
     * 选区拖动 / 缩放（RegionOverlay 回调）。
     *
     * 每帧都相对起点快照重算 + 吸附，然后以 `merge` 提交 `move`——
     * 拖一次只占一步撤销，⌘Z 直接回到拖动前。气泡布局读的就是 regions，
     * 所以说明气泡会跟着框一起走。
     */
    const handleRegionTransform = (
      id: string,
      mode: RegionTransformMode,
      handle: ResizeHandle | null,
      dx: number,
      dy: number
    ) => {
      let drag = regionDragRef.current
      if (!drag || drag.id !== id) {
        const payload = findPayload(regionsRef.current, id, (item) => item.id)
        if (!payload) return
        drag = { id, before: payload }
        regionDragRef.current = drag
        setTransformingId(id)
      }
      const base = drag.before.value
      const w = Math.max(1, boxSize.w)
      const h = Math.max(1, boxSize.h)
      // 吸附阈值 8 屏幕像素：再大会「吸得拖不动」，再小手感上等于没有
      const tol = { x: 8 / w, y: 8 / h }
      const others = regionsRef.current.filter((item) => item.id !== id).map((item) => item.region)
      let next: EditRegion
      if (mode === 'move' || !handle) {
        const moved = translateRegion(base, dx, dy)
        const snap = snapRegion(
          moved.region,
          others,
          tol,
          { x: ['start', 'mid', 'end'], y: ['start', 'mid', 'end'] },
          'move'
        )
        next = translateRegion(base, dx + snap.region.x - moved.region.x, dy + snap.region.y - moved.region.y)
        setSnapGuides(snap.guides)
      } else {
        const min = { w: MIN_BOX_PX / w, h: MIN_BOX_PX / h }
        const resized = resizeRegion(base, handle, dx, dy, min)
        const snap = snapRegion(resized.region, others, tol, handleEdges(handle), 'resize')
        next = {
          ...resized,
          region: { ...snap.region, w: Math.max(min.w, snap.region.w), h: Math.max(min.h, snap.region.h) },
        }
        setSnapGuides(snap.guides)
      }
      commit(
        {
          type: 'move',
          target: 'region',
          id,
          before: drag.before,
          after: { index: drag.before.index, value: next },
        },
        { merge: true }
      )
    }

    const handleRegionTransformEnd = () => {
      regionDragRef.current = null
      setTransformingId(null)
      setSnapGuides([])
    }

    /** 打开某个已有选区的说明气泡：记下当时的文字，供「取消」还原 */
    const activateRegion = (id: string) => {
      const item = regionsRef.current.find((region) => region.id === id)
      bubbleSnapshotRef.current = { id, prompt: item?.prompt ?? '', fresh: false }
      setActiveRegionId(id)
    }

    /**
     * 取消当前区域的编辑：
     * - 刚画出来的框 → 整个删掉（等于「我不要这个框」，⌘Z 可找回）；
     * - 已有的框 → 说明文字还原到打开气泡时的样子，再收起。
     */
    const cancelRegionEdit = (id: string) => {
      const snapshot = bubbleSnapshotRef.current
      bubbleSnapshotRef.current = null
      if (snapshot?.id === id && snapshot.fresh) {
        handleDeleteRegion(id)
        return
      }
      if (snapshot?.id === id) handleRegionPromptChange(id, snapshot.prompt)
      setActiveRegionId(null)
    }

    /** 确认：只是收起气泡（说明已经实时写进选区），把焦点交还给 chip 方便继续键盘操作 */
    const confirmRegionEdit = (id: string) => {
      bubbleSnapshotRef.current = null
      setActiveRegionId(null)
      requestAnimationFrame(() => chipRefs.current[id]?.focus({ preventScroll: true }))
    }

    /** 重画：删掉这个框并切回画它的那种工具，用户直接在图上再画一次 */
    const redrawRegion = (id: string) => {
      const item = regionsRef.current.find((region) => region.id === id)
      if (!item) return
      handleDeleteRegion(id)
      setTool(item.kind === 'brush' ? 'brush' : item.kind === 'lasso' ? 'lasso' : 'region')
      setToolPulse((value) => value + 1)
    }

    /** 光标预览圈：跟随指针，直径 = 当前笔刷在屏幕上的真实粗细 */
    const moveBrushCursor = (event: React.PointerEvent<HTMLElement>) => {
      const cursor = brushCursorRef.current
      const wrap = wrapperRef.current
      if (!cursor || !wrap || event.pointerType === 'touch') return
      const b = wrap.getBoundingClientRect()
      cursor.style.display = 'block'
      cursor.style.left = `${event.clientX - b.left}px`
      cursor.style.top = `${event.clientY - b.top}px`
    }
    const hideBrushCursor = () => {
      if (brushCursorRef.current) brushCursorRef.current.style.display = 'none'
    }

    const handleDeleteRegion = (id: string) => {
      const payload = findPayload(regionsRef.current, id, (item) => item.id)
      if (payload) {
        // 删除也进栈：删错了能 Ctrl+Z 找回来（含画笔区域的全部笔迹）
        commit({ type: 'remove', target: 'region', id, before: payload })
      }
      // 删掉的正是当前输入目标 → 清空，避免气泡指向一个已不存在的区域
      setActiveRegionId((prev) => (prev === id ? null : prev))
      if (shake?.id === id) setShake(null)
    }
    // 命令式句柄（Esc 取消新框）要调用它；走 ref 拿最新版本，句柄本身不必每次渲染重建
    const deleteRegionRef = useRef(handleDeleteRegion)
    deleteRegionRef.current = handleDeleteRegion

    // ==========================================================================
    // 标注（边框 / 标记）：只做视觉提示，**不产生选区、不弹指令气泡**（PRD D3）
    // ==========================================================================

    /** 边框 / 标记的归一化线宽：与涂鸦共用「细 / 中 / 粗」，但设下限保证 1K 图上可见 */
    const annotationWidth = () => Math.max(size, 0.006)

    /** 新增一个标注对象：唯一入口，保证进撤销栈 + 自动选中 */
    const addAnnotation = (annotation: AnnotationObject) => {
      commit({
        type: 'add',
        target: 'annotation',
        id: annotation.id,
        after: { index: annotationsRef.current.length, value: annotation },
      })
      setSelectedAnnotationId(annotation.id)
    }

    /** 边框：拖拽绘制矩形/椭圆，松手落成标注对象（不落选区） */
    const handleBorderDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (submitting) return
      // 与框选一致：开始画就把气泡/chip 隐掉（不卸载，松手原样回来）
      setDrafting(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      const p = toNorm(e.clientX, e.clientY)
      borderStartRef.current = p
      setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 })
    }

    const handleBorderMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const start = borderStartRef.current
      if (!start) return
      const p = toNorm(e.clientX, e.clientY)
      setDraftRect({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      })
    }

    const handleBorderUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const start = borderStartRef.current
      borderStartRef.current = null
      setDraftRect(null)
      setDrafting(false)
      if (!start) return
      const p = toNorm(e.clientX, e.clientY)
      const el = wrapperRef.current
      const pxW = Math.abs(p.x - start.x) * (el?.clientWidth ?? 1)
      const pxH = Math.abs(p.y - start.y) * (el?.clientHeight ?? 1)
      // 误触（点一下 / 手抖）静默丢弃：弹错误条会把误触放大成「出错了」
      if (pxW < MIN_BOX_PX || pxH < MIN_BOX_PX) return
      const box: Box = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      }
      addAnnotation(
        createBorderAnnotation({
          box,
          color,
          width: annotationWidth(),
          shape: borderShape,
          dash: borderDash,
        })
      )
    }

    /** 标记：箭头拖拽绘制；序号/文字点一下就地创建 */
    const handleMarkerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (submitting) return
      setDrafting(true)
      e.currentTarget.setPointerCapture(e.pointerId)
      pointerStartScreenRef.current = { x: e.clientX, y: e.clientY }
      const p = toNorm(e.clientX, e.clientY)
      markerStartRef.current = p
      if (markerShape === 'arrow') setDraftRect({ x: p.x, y: p.y, w: 0, h: 0 })
    }

    const handleMarkerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const start = markerStartRef.current
      if (!start || markerShape !== 'arrow') return
      const p = toNorm(e.clientX, e.clientY)
      setDraftRect({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      })
    }

    const handleMarkerUp = (e: React.PointerEvent<HTMLDivElement>) => {
      const start = markerStartRef.current
      const screenStart = pointerStartScreenRef.current
      markerStartRef.current = null
      pointerStartScreenRef.current = null
      setDraftRect(null)
      setDrafting(false)
      if (!start) return
      const p = toNorm(e.clientX, e.clientY)
      const el = wrapperRef.current
      const moved = screenStart
        ? Math.hypot(e.clientX - screenStart.x, e.clientY - screenStart.y)
        : 0
      const slop = e.pointerType === 'touch' ? CLICK_SLOP_COARSE : CLICK_SLOP_FINE

      if (markerShape === 'arrow') {
        const pxLength = Math.hypot(
          (p.x - start.x) * (el?.clientWidth ?? 1),
          (p.y - start.y) * (el?.clientHeight ?? 1)
        )
        // 太短的箭头没有指向意义，当作误触丢弃
        if (pxLength < MIN_BOX_PX) return
        addAnnotation(
          createMarkerAnnotation({
            shape: 'arrow',
            from: start,
            to: p,
            color,
            width: annotationWidth(),
          })
        )
        return
      }

      // 序号 / 文字：只认「点一下」，拖动超过容差视为误触（与框选/套索同一套判据）
      if (moved > slop) return

      if (markerShape === 'index') {
        const index = nextAnnotationIndex(annotationSeqRef.current, annotationsRef.current)
        addAnnotation(
          createMarkerAnnotation({
            shape: 'index',
            from: start,
            color,
            width: annotationWidth(),
            index,
          })
        )
        // 编号器只前进不回收（R08：删除不回收号码）
        annotationSeqRef.current = index + 1
        setAnnotationSeq(index + 1)
        return
      }

      // 文字标签：先开就地输入，确认后再落对象——否则会出现一堆空标签
      setLabelDraft({ x: start.x, y: start.y, text: '' })
    }

    /** 确认文字标签输入（Enter / 失焦）。空内容 = 取消，不落对象。 */
    const confirmLabelDraft = () => {
      const draft = labelDraft
      setLabelDraft(null)
      if (!draft) return
      const text = draft.text.trim().slice(0, ANNOTATION_LABEL_MAX)
      if (!text) return
      addAnnotation(
        createMarkerAnnotation({
          shape: 'label',
          from: { x: draft.x, y: draft.y },
          color,
          width: annotationWidth(),
          text,
        })
      )
    }

    /** 标注拖动开始：快照当前对象，作为撤销栈里 move op 的 `before` */
    const handleAnnotationDragStart = (id: string) => {
      const payload = findPayload(annotationsRef.current, id, (item) => item.id)
      if (!payload) return
      annotationDragRef.current = { id, before: payload }
    }

    /**
     * 标注拖动：每帧提交一次 `move`，靠 `merge` 合并成「一次拖拽 = 一步撤销」。
     * 位移始终相对**拖动起点**计算（`before` 是不动的快照），所以不会累积误差。
     */
    const handleAnnotationDragMove = (id: string, dx: number, dy: number) => {
      const drag = annotationDragRef.current
      if (!drag || drag.id !== id) return
      // 拖动期间同样隐掉气泡（复用绘制期的 drafting 开关，不另开一套）
      setDrafting(true)
      const moved = translateAnnotation(drag.before.value, dx, dy)
      commit(
        {
          type: 'move',
          target: 'annotation',
          id,
          before: drag.before,
          after: { index: drag.before.index, value: moved },
        },
        { merge: true }
      )
    }

    const handleAnnotationDragEnd = () => {
      annotationDragRef.current = null
      setDrafting(false)
    }

    const handleAnnotationDelete = (id: string) => {
      const payload = findPayload(annotationsRef.current, id, (item) => item.id)
      if (!payload) return
      commit({ type: 'remove', target: 'annotation', id, before: payload })
      setSelectedAnnotationId((prev) => (prev === id ? null : prev))
    }

    /**
     * 区域提示词 / 能力的手动修改**不进撤销栈**：
     * 它们是文本输入，用户期望 Ctrl+Z 撤销的是「刚打的字」而不是「上一步框选」，
     * 混进同一条栈会让「撤销框选」变得极其难命中。
     */
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
        // 「打开的表面」新增了文字标签输入框：Esc 必须先收它，而不是直接退出编辑
        hasOpenSurface: () => drafting || activeRegionId !== null || labelDraft !== null,
        collapseActiveSurface: () => {
          // 拖拽中 / 文字标签输入中：与 pointercancel 走同一条「中止」路径，
          // 气泡与已写内容原样回来（R19 的显隐开关不在这里，它是持久状态）
          if (drafting || labelDraft !== null) {
            abortDrafting()
            return
          }
          const id = activeRegionId
          // 刚画出来、一个字都没写就按 Esc：用户的意思是「这个框不要了」
          const snapshot = bubbleSnapshotRef.current
          const current = regionsRef.current.find((item) => item.id === id)
          if (id && snapshot?.id === id && snapshot.fresh && !current?.prompt.trim()) {
            bubbleSnapshotRef.current = null
            deleteRegionRef.current(id)
            return
          }
          setActiveRegionId(null)
          if (id) requestAnimationFrame(() => chipRefs.current[id]?.focus({ preventScroll: true }))
        },
      }),
      [getMaskFile, activeRegionId, drafting, labelDraft, abortDrafting]
    )

    /**
     * 工具快捷键（R15 / R17）：`R/L/B/P/F/M/E` 切工具，`Ctrl+Z` / `Ctrl+Shift+Z` 撤销重做。
     *
     * 三条守卫：
     * 1. 输入法组词中（`isComposing`）一律不拦——否则中文输入会被工具切换打断；
     * 2. 焦点在输入框内不拦（`Ctrl+Z` 交给浏览器做文本撤销）；
     * 3. 带修饰键（除 Ctrl/Cmd+Z）不拦，避免和宿主/浏览器快捷键打架。
     */
    useEffect(() => {
      if (!open) return
      const onKey = (event: KeyboardEvent) => {
        if (event.isComposing) return
        const active = document.activeElement as HTMLElement | null
        const typing =
          !!active &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable === true)
        const mod = event.metaKey || event.ctrlKey
        if (mod && (event.key === 'z' || event.key === 'Z')) {
          if (typing) return
          event.preventDefault()
          if (event.shiftKey) handleRedo()
          else handleUndo()
          return
        }
        // Windows 用户的肌肉记忆：Ctrl+Y 重做
        if (mod && (event.key === 'y' || event.key === 'Y') && !event.shiftKey) {
          if (typing) return
          event.preventDefault()
          handleRedo()
          return
        }
        // 气泡展开但焦点不在输入框里时，Delete / Backspace 删除这个选区
        if (!typing && !mod && activeRegionId && (event.key === 'Delete' || event.key === 'Backspace')) {
          event.preventDefault()
          handleDeleteRegion(activeRegionId)
          return
        }
        if (typing || mod || event.altKey) return
        const map: Record<string, Tool> = {
          r: 'region',
          l: 'lasso',
          b: 'brush',
          p: 'pen',
          f: 'border',
          m: 'marker',
          e: 'eraser',
        }
        const next = map[event.key.toLowerCase()]
        if (!next) return
        event.preventDefault()
        setTool(next)
        // 切工具时中止任何进行中的绘制，避免「按了快捷键但旧工具的框还挂在画面上」
        if (drafting) abortDrafting()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, drafting, abortDrafting, undo, redo, activeRegionId])

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
      const annotationItems = annotationsRef.current
      if (regions.length === 0 && strokes.length === 0 && annotationItems.length === 0) {
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
        /**
         * 纯标注（边框 / 标记）无选区、也没写文字指令时的兜底指令。
         *
         * 为什么不是直接拒绝：用户画了箭头和序号，本身就是在表达「这几处要改」；
         * 一句「请先输入修改提示词」会让人以为标注白画了。这里用标注计数拼一句
         * 可执行的指令，具体改什么由上游按标注位置理解（与 pen 走同一条合成路径）。
         */
        const stats = annotationStats(annotationItems)
        if (stats.border + stats.marker === 0) {
          onError?.('请先输入修改提示词')
          return
        }
        const parts: string[] = []
        if (stats.border > 0) parts.push(`${stats.border} 处边框`)
        if (stats.marker > 0) parts.push(`${stats.marker} 处标记`)
        finalPrompt = `按图上标注修改：${parts.join('、')}。其余部分保持原样。`
      }

      try {
        const payload = await buildEditPayload({
          dataUrl,
          regions: regions.map((r) => r.region),
          strokes,
          // 标注对象（边框 / 标记）只画进 guideFile，绝不进掩码、绝不进 baseCanvas
          annotations: annotationItems,
          // 每个区域都画红框：上游需要知道「改哪里」，抠图区域同样要标出来
          markIndexes: regions.map((_, index) => index),
          // 画笔区域额外带笔迹：掩码按真实笔画走，而不是整块包围盒
          brushRegions: regions
            .filter((item) => item.kind === 'brush' && (item.strokes?.length ?? 0) > 0)
            .map((item) => ({ region: item.region, strokes: item.strokes ?? [] })),
        })
        // 纯涂鸦/纯标注没有矩形框时，用它们的包围盒告知图像模型处理范围。
        const finalOps =
          ops.length > 0
            ? ops
            : payload.regions.map((region) => ({
                region,
                handler: 'restyle',
                prompt: finalPrompt,
                intensity: 'fine' as const,
              }))
        /**
         * 标注计数（R09）：后端只写日志、不入库。
         * `doodle` 要把涂鸦笔迹数一起加上——涂鸦仍在 `strokes` 里，不在标注数组里。
         */
        const stats = annotationStats(annotationItems, strokes.length)
        onSubmit({
          ...payload,
          ops: finalOps,
          prompt: finalPrompt,
          annotation_stats: JSON.stringify(stats),
        })
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
     *
     * 纯标注（边框 / 标记）也算「有内容」：R09 要求它们能独立提交，
     * 以全部标注的包围盒作为修改区域。
     */
    const canSubmit =
      !submitting &&
      !analyzing &&
      (regions.length > 0 ||
        annotations.length > 0 ||
        (prompt.trim().length > 0 && strokeCount > 0))

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
      const BUBBLE_H = 176
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
    const borderTool = tool === 'border'
    const markerTool = tool === 'marker'
    /** 颜色作用于哪些工具（框选/套索是选区，不用色；画笔固定红色） */
    const colorActive = tool === 'pen' || tool === 'border' || tool === 'marker'
    /** 线宽作用于哪些工具（矩形框选/套索不用） */
    const sizeActive = !regionTool && !lassoTool

    /**
     * 纯标注无选区时的兜底包围盒（PRD §3.1-R07/R09 / D3）。
     * 必须在**提交前**一直可见：只在 `regions.length === 0` 时出现，
     * 有选区时修改区域就是选区本身，不需要再叠一层框。
     */
    const fallbackBox =
      regions.length === 0 ? annotationsBBox(annotations) : null

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
                  : tool === 'eraser' || tool === 'pen'
                    ? 'none'
                    : 'crosshair',
            }}
            onPointerDown={handlePenDown}
            onPointerMove={(event) => {
              if (tool === 'pen' || tool === 'eraser') moveBrushCursor(event)
              handlePenMove(event)
            }}
            onPointerLeave={hideBrushCursor}
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
              // 激活 / 悬停的选区：底色加深 + 蚂蚁线流动 + 外发光，从多个红框里一眼拎出来
              const emphasis = activeRegionId === item.id || hoveredRegionId === item.id
              const common = {
                fill: emphasis ? 'rgba(255, 64, 64, 0.2)' : 'rgba(255, 64, 64, 0.12)',
                stroke: 'rgba(220, 38, 38, 0.95)',
                strokeWidth: emphasis ? 2.5 : 2,
                strokeDasharray: activeRegionId === item.id ? '7 7' : undefined,
                className: cn(
                  'transition-[fill] duration-200',
                  activeRegionId === item.id && 'cs-marching cs-region-active'
                ),
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
                strokeDasharray="7 7"
                className="cs-marching"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {/* 吸附参考线：告诉用户「对齐到了图片中线 / 边缘 / 另一个框」 */}
            {snapGuides.map((guide) =>
              guide.axis === 'x' ? (
                <line
                  key={`gx-${guide.at}`}
                  x1={guide.at * 100}
                  x2={guide.at * 100}
                  y1={0}
                  y2={100}
                  className="cs-snap-guide"
                  vectorEffect="non-scaling-stroke"
                />
              ) : (
                <line
                  key={`gy-${guide.at}`}
                  x1={0}
                  x2={100}
                  y1={guide.at * 100}
                  y2={guide.at * 100}
                  className="cs-snap-guide"
                  vectorEffect="non-scaling-stroke"
                />
              )
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

          {/* 选区外壳：编号徽章（拖动移动 / 单击写说明）+ 删除 + 缩放把手 */}
          {regions.map((item, index) => (
            <RegionOverlay
              key={`overlay-${item.id}`}
              item={item}
              index={index}
              box={boxSize}
              natural={{ w: naturalWidth, h: naturalHeight }}
              active={activeRegionId === item.id}
              hovered={hoveredRegionId === item.id}
              transforming={transformingId === item.id}
              disabled={submitting || drafting}
              onActivate={activateRegion}
              onHover={setHoveredRegionId}
              onTransform={handleRegionTransform}
              onTransformEnd={handleRegionTransformEnd}
              onDelete={handleDeleteRegion}
            />
          ))}

          {/* 正在拉框：实时显示「原图上的像素尺寸」，用户知道自己框了多大一块 */}
          {draftRect && draftRect.w > 0 && draftRect.h > 0 && (
            <span
              className="cs-dim-label absolute z-30"
              style={{
                left: `${(draftRect.x + draftRect.w) * 100}%`,
                top: `${(draftRect.y + draftRect.h) * 100}%`,
                transform: 'translate(-100%, 6px)',
              }}
            >
              {Math.round(draftRect.w * naturalWidth)} × {Math.round(draftRect.h * naturalHeight)}
            </span>
          )}

          {/* 笔刷光标预览：直径 = 笔刷在屏幕上的真实粗细（画笔选区 / 涂鸦 / 橡皮） */}
          {(brushTool || tool === 'pen' || tool === 'eraser') && (
            <span
              ref={brushCursorRef}
              aria-hidden
              data-eraser={tool === 'eraser' ? '' : undefined}
              className="cs-brush-cursor"
              style={{
                display: 'none',
                width: Math.max(
                  6,
                  boxSize.w *
                    (brushTool
                      ? Math.max(size, BRUSH_MIN_WIDTH)
                      : tool === 'eraser'
                        ? size * ERASE_SCALE
                        : size)
                ),
                height: Math.max(
                  6,
                  boxSize.w *
                    (brushTool
                      ? Math.max(size, BRUSH_MIN_WIDTH)
                      : tool === 'eraser'
                        ? size * ERASE_SCALE
                        : size)
                ),
              }}
            />
          )}

          {/* 标注层（R07 边框 / R08 标记 / R19 显隐 / D3 兜底包围盒）。
              z-20 但 `pointer-events-none`：只有标注几何附近才接管指针，
              其余区域透给下面的绘制层——否则「在已有边框里再画一个更小的框」点不进去。 */}
          <AnnotationLayer
            items={annotations}
            width={boxSize.w}
            height={boxSize.h}
            visible={annotationVisible}
            onToggleVisible={() => setAnnotationVisible((prev) => !prev)}
            selectedId={selectedAnnotationId}
            onSelect={setSelectedAnnotationId}
            onDragStart={handleAnnotationDragStart}
            onDragMove={handleAnnotationDragMove}
            onDragEnd={handleAnnotationDragEnd}
            onCancel={abortDrafting}
            onDelete={handleAnnotationDelete}
            fallbackBox={fallbackBox}
            naturalWidth={naturalWidth}
            naturalHeight={naturalHeight}
            disabled={submitting}
          />

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
              style={{ cursor: 'none' }}
              onPointerDown={handleBrushDown}
              onPointerMove={(event) => {
                moveBrushCursor(event)
                handleBrushMove(event)
              }}
              onPointerLeave={hideBrushCursor}
              onPointerUp={handleBrushUp}
              onPointerCancel={abortDrafting}
            />
          )}

          {/* 边框交互层（R07）：拖拽画矩形/椭圆，松手落成标注对象（不产生选区） */}
          {borderTool && (
            <div
              className="absolute inset-0 z-10 touch-none"
              style={{ cursor: 'crosshair' }}
              onPointerDown={handleBorderDown}
              onPointerMove={handleBorderMove}
              onPointerUp={handleBorderUp}
              // cancel 与 Esc 走同一条中止路径：不落标注、不留半截预览
              onPointerCancel={abortDrafting}
            />
          )}

          {/* 标记交互层（R08）：箭头拖拽；序号/文字点一下 */}
          {markerTool && (
            <div
              className="absolute inset-0 z-10 touch-none"
              style={{ cursor: markerShape === 'arrow' ? 'crosshair' : 'copy' }}
              onPointerDown={handleMarkerDown}
              onPointerMove={handleMarkerMove}
              onPointerUp={handleMarkerUp}
              onPointerCancel={abortDrafting}
            />
          )}

          {/* 文字标签就地输入：贴在点击位置，Enter 确认 / Esc 取消（Esc 由宿主统一裁决） */}
          {labelDraft && (
            <input
              data-annotation-label-input
              autoFocus
              maxLength={ANNOTATION_LABEL_MAX}
              value={labelDraft.text}
              placeholder="输入标签（≤20 字）"
              onChange={(event) =>
                setLabelDraft((prev) => (prev ? { ...prev, text: event.target.value } : prev))
              }
              onBlur={confirmLabelDraft}
              onKeyDown={(event) => {
                // 输入法组词中的回车是选词，不是确认
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') {
                  event.preventDefault()
                  confirmLabelDraft()
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className="absolute z-40 w-[160px] -translate-y-1/2 rounded-[8px] bg-surface-raised px-2 py-1 text-[12px] text-text shadow-sheet placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand/40"
              style={{
                left: `${Math.min(88, labelDraft.x * 100)}%`,
                top: `${labelDraft.y * 100}%`,
              }}
            />
          )}
        </div>

        {/* 顶部工具条：下移避开 Excalidraw 原生工具条（避免两条工具栏重叠） */}
        <EditToolbar
          tool={tool}
          onToolChange={(next) => {
            setTool(next)
            if (drafting) abortDrafting()
          }}
          colors={COLORS}
          color={color}
          onColor={(next) => {
            setColor(next)
            if (!colorActive) setTool('pen')
          }}
          sizes={SIZES}
          size={size}
          onSize={setSize}
          borderShape={borderShape}
          onBorderShape={setBorderShape}
          markerShape={markerShape}
          onMarkerShape={setMarkerShape}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          canClear={strokeCount > 0}
          onClear={handleClearStrokes}
          regionCount={regions.length}
          filledCount={filledRegionCount}
          markCount={strokeCount + annotations.length}
          canSubmit={canSubmit}
          submitting={Boolean(submitting)}
          onSubmit={() => void handleSubmit()}
          onExit={onClose}
          onDeleteImage={onDelete}
          pulseToken={toolPulse}
        />

        {/* 首次进入编辑：三步引导，贴在图片下方，开始画就自动收起 */}
        <EditCoach
          hidden={drafting || regions.length > 0 || annotations.length > 0}
          style={composerStyle}
        />

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
                    ? t('chip.filled_label', { index: index + 1, prompt: item.prompt.trim() })
                    : t('chip.empty_label', { index: index + 1 })
                }
                onClick={() => activateRegion(item.id)}
                onPointerEnter={() => setHoveredRegionId(item.id)}
                onPointerLeave={() => setHoveredRegionId(null)}
                style={style}
                title={t('chip.title')}
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
                  {item.prompt.trim() || t('chip.empty')}
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
              aria-label={t('bubble.label', { index: index + 1 })}
              onPointerEnter={() => setHoveredRegionId(item.id)}
              onPointerLeave={() => setHoveredRegionId(null)}
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
                  {t('bubble.title', { index: index + 1 })}
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
                  <BubbleIconButton
                    label={t('bubble.redraw')}
                    onClick={() => redrawRegion(item.id)}
                  >
                    <RotateCcw size={12} />
                  </BubbleIconButton>
                  <BubbleIconButton
                    label={t('bubble.delete')}
                    danger
                    onClick={() => handleDeleteRegion(item.id)}
                  >
                    <Trash2 size={12} />
                  </BubbleIconButton>
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
                    confirmRegionEdit(item.id)
                  }
                  // Esc 不在这里处理：收起气泡还是退出编辑，统一由宿主按「有没有展开气泡」裁决
                }}
                placeholder={t('bubble.placeholder')}
                className="w-full resize-none rounded-[10px] bg-bg-subtle px-2.5 py-2 text-[12px] leading-relaxed text-text placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-brand/40"
              />
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-faint">
                {/* 快捷键只在桌面端有意义；触屏给「点图片收起」（图内空白=收起，图外=退出） */}
                <span className="pointer-coarse:hidden">{t('bubble.keys')}</span>
                <span className="hidden pointer-coarse:inline">{t('bubble.keys_touch')}</span>
                {/* 字数可牺牲：空间不足时先丢它，绝不截断快捷键提示 */}
                {item.prompt.trim().length >= 80 && (
                  <span className="ml-auto min-w-0 truncate tabular-nums">
                    {t('bubble.chars', { count: item.prompt.trim().length })}
                  </span>
                )}
              </div>
              {/* 快捷操作：取消 / 确认 是「这一块」的去留；去创作 是把这一块交给对话做深度出图 */}
              <div className="mt-1.5 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => cancelRegionEdit(item.id)}
                  className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <X size={12} /> {t('bubble.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => confirmRegionEdit(item.id)}
                  disabled={!item.prompt.trim()}
                  className="inline-flex h-7 items-center gap-1 rounded-full bg-brand px-2.5 text-[11px] font-semibold text-text-inverse transition-[filter,opacity] hover:brightness-110 disabled:opacity-40"
                >
                  <Check size={12} strokeWidth={2.6} /> {t('bubble.confirm')}
                </button>
                <button
                  type="button"
                  data-edit-layer-ui
                  disabled={!item.prompt.trim() || submitting || analyzing}
                  onClick={() => handleGoCreate(item.id)}
                  title={t('bubble.go_create_hint')}
                  className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-accent-ink ring-1 ring-inset ring-accent-strong/60 transition-colors hover:bg-accent-soft disabled:opacity-40"
                >
                  <Sparkles size={11} /> {t('bubble.go_create')}
                </button>
              </div>
            </div>
          )
        })}


        {/* 只保留一个状态条：输入已经全部收进选区气泡，底部不再重复放输入框 */}
        {(analyzing || submitting) && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-surface-raised px-3 py-1.5 text-[11px] text-text-secondary shadow-sheet">
            <Loader2 size={12} className="animate-spin" />
            {analyzing ? t('status.analyzing') : t('status.submitting')}
          </div>
        )}
      </div>
    )
  }
)

function BubbleIconButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        danger ? 'hover:bg-danger-subtle hover:text-danger' : 'hover:bg-surface-hover hover:text-text'
      )}
    >
      {children}
    </button>
  )
}
