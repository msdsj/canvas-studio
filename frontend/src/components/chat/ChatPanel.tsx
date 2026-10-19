import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  Check,
  Images,
  LibraryBig,
  Loader2,
  Plus,
  Settings2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePolling } from '@/hooks/use-polling'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import { assetsApi } from '@/lib/api/assets'
import { aiApi, type DesignSkill, type RelayStatus } from '@/lib/api/ai'
import {
  chatApi,
  pickComposeRun,
  pickImages,
  pickSkillRun,
  type AnalyzeResult,
  type ChatSelectionPayload,
  type ComposeOption,
  type ComposeResult,
  type ComposeStep,
  type SkillOption,
  type SkillStepState,
} from '@/lib/api/chat'
import { ApiError, apiUrl } from '@/lib/api/client'
import { generateApi } from '@/lib/api/generate'
import { events } from '@/lib/events'
import { errorMessage } from '@/lib/errors'
import { parseServerTime } from '@/lib/utils'
import { loadPlacedUrls, readNotifiedResults, writeNotifiedResults } from '@/lib/task-persistence'
import { useUIStore } from '@/stores/ui'
import { useComposerHandoff } from '@/stores/composer'
import { useComposerRefs, MAX_COMPOSER_REFS, type ComposerRef } from '@/stores/composer-refs'
import type { CanvasSelectionContext } from '@/types/selection'
import { ChatMessage } from './ChatMessage'
import { AgentGlyph } from './agent/AgentGlyph'
import { AgentTrace, type TraceStep } from './agent/AgentTrace'
import { AgentWelcome } from './agent/AgentWelcome'
import { PromptGuide } from './agent/PromptGuide'
import { ChatTextarea, type ComposerAttachment } from './ChatTextarea'
import { GenerationResultCard } from './GenerationResultCard'
import { ConfirmCountCard, type ConfirmCardState } from './ConfirmCountCard'
import { ClarifyCard, type ClarifyState } from './ClarifyCard'
import { SkillLibraryPanel } from './SkillLibraryPanel'
import { PolishPopover } from './PolishPopover'
import { AIConfigDialog } from '@/components/ai/AIConfigDialog'


import { SkillRunCard } from './SkillRunCard'
import type { ChatMessage as ChatMessageType, ChatSession, GenerationTask } from '@/types/models'

/**
 * 上游实际支持的 GPT 生图模型。
 *
 * 2.5 不是「一个模型」：`flare` 与 `sunburst` 是两个独立 key（定价也不同），
 * 合并成「2.5」会让用户以为只有一档，实际出图效果与成本都由 key 决定。
 */
const IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'GPT Image 2.0', short: 'GPT 2.0' },
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 · Flare', short: '2.5 Flare' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 · Sunburst', short: '2.5 Sunburst' },
]




interface ChatPanelProps {
  canvasId?: string
  sessionId: string | null
  onSessionChange: (id: string) => void
  onAddResultToCanvas?: (url: string, taskId: string) => Promise<void> | void
  /** 有新的成功结果时通知父级自动落画布（父级负责去重 / 找空位 / 聚焦） */
  onResultsReady?: (urls: string[], taskKey: string) => Promise<void> | void
  /** 上传本地参考图 */
  onUpload?: () => void
  /** 从素材库选图 */
  onPickAsset?: () => void
  /** 画布当前选区（需求分析中转站的输入之一） */
  selection?: CanvasSelectionContext | null
  /** 「缺少底图」时把用户带回画布（不传则该按钮不出现） */
  onFocusCanvas?: () => void
  /** 首页交接下来的一句话：会话就绪后自动提交（只消费一次） */
  initialPrompt?: string | null
  /** 首页选好的参考图，随首次提交一起上传 */
  initialFiles?: File[]
  onInitialConsumed?: () => void
}

/** 同一会话的并发上限（与后端 max_active_tasks_per_user 保持一致）。 */
const MAX_ACTIVE_TASKS = 2
const DRAFT_PREFIX = 'cs.draft:'

type TimelineEntry =
  | { kind: 'message'; at: number; message: ChatMessageType }
  | { kind: 'task'; at: number; task: GenerationTask }

/** 一张待确认卡：同一时刻只允许存在一个，新的提交会把旧的标记为作废。 */
interface PendingConfirm {
  runId: string
  fingerprint: string
  options: SkillOption[]
  reply: string
  reason: string
  state: ConfirmCardState
  chosenId?: string
}

interface AnalysisState {
  steps: SkillStepState[]
  active: boolean
}

/** 澄清卡的本地状态（选了哪个 / 是否已提交）。 */
interface ComposeRunUiState {
  state: ClarifyState
  chosenId?: string
}

function timeOf(value?: string | null): number {
  // 服务端是 naive UTC：不补 Z 会被当成本地时间，时间线排序和计时都会偏 8 小时
  return parseServerTime(value)?.getTime() ?? 0
}

/** 步骤按 id 去重覆盖：后端对同一步先发 running、再发 done，不能追加成两行。 */
function upsertStep<T extends { id: string }>(steps: T[], next: T): T[] {
  const index = steps.findIndex((step) => step.id === next.id)
  if (index === -1) return [...steps, next]
  const copy = steps.slice()
  copy[index] = next
  return copy
}

/**
 * 生成过程中的实时分析：Agent 头像（工作光环）+ 逐步展开的思考轨迹。
 *
 * 展示的是「每一步在做什么、得出了哪些要点」；最终提示词仍属中间产物，不展示。
 * 完成后这块消失，同一份轨迹以折叠摘要的形式挂到那条 AI 回复上，过程可回看。
 */
function ThinkingBubble({
  steps,
  offline,
  onStop,
  onRetry,
}: {
  steps: TraceStep[]
  offline: boolean
  onStop: () => void
  onRetry?: () => void
}) {
  const { t } = useTranslation('agent')
  return (
    <div className="cs-bubble-in-left flex flex-col gap-1.5" aria-live="polite">
      <div className="flex items-center gap-2">
        <AgentGlyph size={22} active />
        <span className="text-caption font-semibold text-text">{t('name')}</span>
      </div>
      <div className="min-w-0 pl-[30px]">
        <AgentTrace steps={steps} live offline={offline} onStop={onStop} onRetry={onRetry} />
      </div>
    </div>
  )
}

/**
 * 侧边栏（生图工作区）：会话头 + 瀑布流消息 + 生成任务卡 + 输入区。
 *
 * 只有一条链路：**用户说需求 → 中转站分析 → 不明确就澄清 → 生成最终提示词 → 生图**。
 * 画布上框了选区时改走「按区域编辑」的分析（`/chat/analyze`），其余一律走
 * `/chat/compose`——不存在「闲聊模式」，也不会绕过中转站直接建任务。
 */
export function ChatPanel({
  canvasId,
  sessionId,
  onSessionChange,
  onAddResultToCanvas,
  onResultsReady,
  onUpload,
  onPickAsset,
  selection,
  onFocusCanvas,
  initialPrompt,
  initialFiles,
  onInitialConsumed,
}: ChatPanelProps) {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation()
  const { t: ta } = useTranslation('agent')
  const toast = useToast()
  const { canAfford, prices } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null)
  const [placedUrls, setPlacedUrls] = useState<string[]>(() => loadPlacedUrls())
  const [preview, setPreview] = useState<{ url: string; prompt: string } | null>(null)
  const [online, setOnline] = useState(true)
  const [showJump, setShowJump] = useState(false)
  /** 消息列表加载中（切换会话时先给骨架，避免"空白闪一下"） */
  const [messagesLoading, setMessagesLoading] = useState(false)
  /** 离开底部期间新增的消息条数 */
  const [newCount, setNewCount] = useState(0)
  /** 画布框选编辑的实时分析块（随 SSE onStep 更新） */
  const [analysis, setAnalysis] = useState<AnalysisState | null>(null)
  /** 待确认方案卡（时间线尾部） */
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  /** 「缺少底图」内联提示 */
  const [needsImage, setNeedsImage] = useState(false)

  /** 生图全链路：实时思考步骤 */
  const [composeSteps, setComposeSteps] = useState<ComposeStep[]>([])
  const [composing, setComposing] = useState(false)
  /** 澄清卡状态：按 runId 记录选择结果，刷新后以消息附件为准 */
  const [composeRunUi, setComposeRunUi] = useState<Record<string, ComposeRunUiState>>({})
  /** 参考图（粘贴 / 选择 / 上传） */
  const [refs, setRefs] = useState<ComposerAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  /** @ 引用图：画布点选 / 结果图带进来的底图（走全局 store，画布那一侧要能直接推） */
  const composerRefs = useComposerRefs((s) => s.refs)
  const removeComposerRef = useComposerRefs((s) => s.removeRef)
  const clearComposerRefs = useComposerRefs((s) => s.clearRefs)
  const refFocusSignal = useComposerRefs((s) => s.focusSignal)

  const [configOpen, setConfigOpen] = useState(false)
  /** 生图模型：只列 GPT（上游 2.5 有两个变体，不要混成同一个） */
  const [imageModel, setImageModel] = useState(
    () => localStorage.getItem('cs.imageModel') || 'gpt-image-2'
  )
  const chooseModel = (value: string) => {
    setImageModel(value)
    localStorage.setItem('cs.imageModel', value)
  }
  const [skillOpen, setSkillOpen] = useState(false)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  /** 上一次提交的内容：未配置中转站时「用本地模板先试一次」要原样重发 */
  const lastComposeRef = useRef<string>('')

  const nearBottomRef = useRef(true)
  /**
   * 本次停留期间见过它「正在跑」的任务 id。
   * 只有这类任务在完成时才提醒；进页面就已完成的属于历史，安静带过。
   */
  const watchersRef = useRef<Set<string>>(new Set())
  const draftTimerRef = useRef<number | null>(null)
  const lastTimelineLenRef = useRef(0)
  /** 已处理过的 run（本会话内确认过的）：历史卡不再提供选择入口，避免重复入口 */
  const resolvedRunsRef = useRef<Set<string>>(new Set())
  /** 已从历史恢复成待确认卡的 run，避免每次轮询都重置卡片状态 */
  const restoredRunsRef = useRef<Set<string>>(new Set())
  /** SSE 取消函数 */
  const analyzeCancelRef = useRef<(() => void) | null>(null)
  const composeCancelRef = useRef<(() => void) | null>(null)
  /** 用户主动取消：onClose 里据此决定「不弹失败提示」 */
  const cancelledRef = useRef(false)

  const loadRelay = useCallback(async () => {
    try {
      setRelay(await aiApi.status())
    } catch {
      /* 状态读取失败不阻塞输入，提交时会再拦一次 */
    }
  }, [])

  useEffect(() => {
    void loadRelay()
  }, [loadRelay])

  const loadMessages = useCallback(async (id: string) => {
    setMessagesLoading(true)
    try {
      const page = await chatApi.listMessages(id)
      setMessages(page.items)
    } catch {
      setMessages([])
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const loadSessions = useCallback(
    async (selectIfEmpty = true) => {
      try {
        // 会话与画布改成 1:1 之后，每个会话都有自己独立的画布，
        // 再按 canvas_id 过滤就只剩当前这一条——历史对话会从下拉里彻底消失，
        // 用户也就没有入口切回去了。这里必须列出该用户的全部会话。
        const list = await chatApi.listSessions()
        setSessions(list)
        if (selectIfEmpty && !sessionId && list.length > 0) {
          onSessionChange(list[0].id)
        }
        if (selectIfEmpty && list.length === 0 && !creating) {
          setCreating(true)
          // 首次进入：已经有一块画布就复用它（避免多出一块空画布没人用）；
          // 连画布都还没有时，才让后端顺手开一块干净画布。
          const created = await chatApi.createSession(
            canvasId ? { canvas_id: canvasId } : { new_canvas: true }
          )
          setSessions([created])
          onSessionChange(created.id)
          setCreating(false)
        }
      } catch {
        /* ignore */
      }
    },
    [canvasId, sessionId, onSessionChange, creating]
  )

  useEffect(() => {
    void loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  useEffect(() => {
    // 切会话先清空旧消息并进入加载态：否则会短暂显示上一个会话的内容
    setMessages([])
    setNewCount(0)
    setAnalysis(null)
    setPending(null)
    setNeedsImage(false)
    setComposeSteps([])
    setRefs([])
    // 切会话时上一个请求的收尾回调可能已经落在旧会话上：必须把提交态清掉，
    // 否则新会话里发送键会一直禁用（表现为「切了个对话就发不出去了」）。
    setComposing(false)
    setSubmitting(false)
    cancelledRef.current = true
    restoredRunsRef.current.clear()
    lastTimelineLenRef.current = 0
    nearBottomRef.current = true
    if (sessionId) void loadMessages(sessionId)
  }, [sessionId, loadMessages])

  // 离开面板/切会话时必须掐掉 SSE，否则回包会写进已经切走的会话视图
  useEffect(() => {
    return () => {
      analyzeCancelRef.current?.()
      analyzeCancelRef.current = null
      composeCancelRef.current?.()
      composeCancelRef.current = null
    }
  }, [sessionId])

  // 草稿：按会话存 sessionStorage，刷新/误关后可恢复
  useEffect(() => {
    if (!sessionId) return
    try {
      const saved = sessionStorage.getItem(`${DRAFT_PREFIX}${sessionId}`)
      if (saved) {
        setInput(saved)
        toast.info(t('draft.restored'))
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const updateInput = (value: string) => {
    setInput(value)
    if (!sessionId) return
    if (draftTimerRef.current) window.clearTimeout(draftTimerRef.current)
    draftTimerRef.current = window.setTimeout(() => {
      try {
        if (value.trim()) sessionStorage.setItem(`${DRAFT_PREFIX}${sessionId}`, value)
        else sessionStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`)
      } catch {
        /* ignore */
      }
    }, 200)
  }

  const clearDraft = () => {
    if (!sessionId) return
    try {
      sessionStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`)
    } catch {
      /* ignore */
    }
  }

  // 网络状态：断网时给一条细提示，恢复后自动刷新一次
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const { data: tasks, refresh: refreshTasks } = usePolling<GenerationTask[]>(
    async () => {
      if (!sessionId) return []
      const page = await generateApi.listTasks({ session_id: sessionId, size: 30 })
      return page.items
    },
    { enabled: Boolean(sessionId) && online, intervalMs: 2500, maxIntervalMs: 10000 }
  )

  const guardAfford = (cost: number): boolean => {
    if (!canAfford(cost)) {
      setQuotaModalOpen(true)
      return false
    }
    return true
  }

  const orderedTasks = useMemo(
    () => [...(tasks ?? [])].sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at)),
    [tasks]
  )

  const activeCount = useMemo(
    () => orderedTasks.filter((task) => task.status === 'queued' || task.status === 'running').length,
    [orderedTasks]
  )

  // 结果到达提示：不再自动落画布，必须显式告诉用户「图好了、在右边」。
  //
  // 去重必须**跨挂载、跨刷新**生效，所以落 localStorage 而不是 useRef：
  // 之前用内存 Set + 「首次进会话只做基线」的逻辑，有两个必然漏弹的口子：
  //   ① ChatPanel 重新挂载（切会话回来、路由进出、HMR）→ Set 清空 → 整批历史任务重新算「新到达」；
  //   ② 首次进会话时任务还在 running（不在 succeeded 列表里），
  //      基线里没有它的 id，等它变成 succeeded 就被当成新结果弹一次——
  //      而这个任务其实用户早就看过了。
  // 现在记录的是 { 任务 id: 已提示过的结果张数 }：
  //   - 任务历史里就有、且提示过 → 不弹
  //   - 只有结果张数变多（例如重试后多产出一张）才补一次提示
  //   - 只提示「在本次停留期间真正跑完」的任务，进页面时已完成的安静地带过
  useEffect(() => {
    if (!sessionId) return
    const succeeded = orderedTasks.filter((task) => task.status === 'succeeded')
    if (succeeded.length === 0) return

    const notified = readNotifiedResults()
    const fresh = succeeded.filter((task) => {
      const count = task.result_urls?.length ?? 0
      if (count === 0) return false
      const seen = notified[task.id] ?? -1
      return count > seen
    })
    if (fresh.length === 0) return

    // 首次见到某个任务时：只有本次停留期间见过它 running，才算"刚跑完"；
    // 否则它是历史结果，只记账不打扰。
    const shouldToast = fresh.filter((task) => task.id in notified || watchersRef.current.has(task.id))

    fresh.forEach((task) => {
      notified[task.id] = task.result_urls.length
    })
    writeNotifiedResults(notified)

    if (shouldToast.length === 0) return
    const count = shouldToast.reduce((sum, task) => sum + task.result_urls.length, 0)
    // 演示占位图不能报「已完成」，否则用户会以为 AI 真的画了
    if (shouldToast.some((task) => task.demo)) {
      toast.warning(t('task.result_demo'), t('demo_hint'))
    } else {
      toast.success(ta('say.done', { count }), ta('say.done_hint'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedTasks, sessionId])

  /**
   * 记录「本次停留期间见过的进行中任务」。
   *
   * 判断依据很朴素：一个任务只要在某次轮询里处于 queued/running，就说明
   * 用户是"看着它跑完"的，完成时提醒一次是合理的；反过来，进页面时它已经是
   * succeeded，那只是历史记录，不该弹窗打扰。
   */
  useEffect(() => {
    orderedTasks.forEach((task) => {
      if (task.status === 'queued' || task.status === 'running') {
        watchersRef.current.add(task.id)
      }
    })
  }, [orderedTasks])

  // 时间线：消息与任务按创建时间统一排序，任务卡挂在对应提示词气泡下面
  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [
      ...messages.map((message) => ({
        kind: 'message' as const,
        at: timeOf(message.created_at),
        message,
      })),
      ...orderedTasks.map((task) => ({ kind: 'task' as const, at: timeOf(task.created_at), task })),
    ]
    return entries.sort((a, b) => a.at - b.at || (a.kind === 'message' ? -1 : 1))
  }, [messages, orderedTasks])

  const scrollAnchorRef = useRef<HTMLDivElement>(null)

  /**
   * 底部「最近生成」展示位：本次会话**最近一次成功且有产出**的任务。
   *
   * 时间线按创建时间排序，最新结果不一定在最底下（例如并发两个任务，
   * 先发的后完成）；所以这里单独按「完成时间」取最近一条，作为主展示。
   */
  const latestTask = useMemo(() => {
    let picked: GenerationTask | null = null
    let pickedAt = -1
    for (const task of orderedTasks) {
      if (task.status !== 'succeeded') continue
      if (!task.result_urls?.length) continue
      const at = timeOf(task.updated_at ?? task.created_at) || timeOf(task.created_at)
      if (at >= pickedAt) {
        pickedAt = at
        picked = task
      }
    }
    return picked
  }, [orderedTasks])

  /**
   * 新结果 → 通知父级自动落画布。
   *
   * 只通知「本次停留期间真的跑完」的任务：进页面时已经完成的历史结果
   * 不应该在每次挂载时被重新塞进画布。
   */
  useEffect(() => {
    if (!latestTask || !onResultsReady) return
    if (!watchersRef.current.has(latestTask.id)) return
    const urls = latestTask.result_urls ?? []
    if (urls.length === 0) return
    void onResultsReady(urls, latestTask.id)
  }, [latestTask, onResultsReady])

  const scrollToBottom = useCallback(() => {
    const viewport = scrollAnchorRef.current?.closest('[data-radix-scroll-area-viewport]')
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    nearBottomRef.current = true
    setShowJump(false)
    setNewCount(0)
  }, [])

  useEffect(() => {
    const viewport = scrollAnchorRef.current?.closest('[data-radix-scroll-area-viewport]') as
      | HTMLElement
      | null
    if (!viewport) return
    const onScroll = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      nearBottomRef.current = distance < 80
      setShowJump(distance > 160)
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', onScroll)
  }, [])

  // 只有用户本来就在底部时才自动跟随，避免把正在翻历史的人拽回来。
  const composeRunning = composing || Boolean(analysis?.active)
  useEffect(() => {
    if (!nearBottomRef.current) return
    const raf = requestAnimationFrame(() => scrollToBottom())
    return () => cancelAnimationFrame(raf)
  }, [timeline.length, composeSteps, composeRunning, scrollToBottom])

  // 离开底部期间新到的消息计入角标
  useEffect(() => {
    const prev = lastTimelineLenRef.current
    const next = timeline.length
    lastTimelineLenRef.current = next
    if (next > prev && !nearBottomRef.current) {
      setNewCount((count) => count + (next - prev))
    }
  }, [timeline.length])

  // --------------------------------------------------------------------- //
  // 画布框选编辑（保留原有链路：按区域拆指令、判定 1/2 张）
  // --------------------------------------------------------------------- //

  /**
   * 把画布选区整理成中转站入参。
   *
   * 有 `buildMask` 时先把并集掩码导成 PNG 上传，再带上 `mask_asset_id`——
   * 掩码是「只改这一块」的唯一凭据，丢了就变成整图重绘。
   */
  const buildSelectionPayload = async (
    context?: CanvasSelectionContext | null
  ): Promise<ChatSelectionPayload | null> => {
    if (!context) return null
    let maskAssetId = context.mask_asset_id ?? null
    if (context.buildMask) {
      const file = await context.buildMask()
      if (file) {
        const uploaded = await assetsApi.upload(file)
        maskAssetId = uploaded.id
      }
    }
    return {
      asset_id: context.asset_id ?? null,
      mask_asset_id: maskAssetId,
      width: context.width ?? 0,
      height: context.height ?? 0,
      has_doodle: Boolean(context.has_doodle),
      regions: (context.regions ?? []).map((region, index) => ({
        index: region.index ?? index + 1,
        region: region.region,
        path: region.path ?? null,
        prompt: region.prompt ?? '',
        handler: region.handler ?? '',
      })),
    }
  }

  /** 历史里那条 run 的选区指纹（确认时必须原样回传）。 */
  const fingerprintOf = useCallback(
    (runId: string): string => {
      if (pending?.runId === runId) return pending.fingerprint
      for (const message of messages) {
        const run = pickSkillRun(message.attachments)
        if (run && run.run_id === runId) return run.selection_fingerprint ?? ''
      }
      return ''
    },
    [messages, pending]
  )

  /** 用户点「就按这个来」：服务端凭 run_id 重建任务，前端只回传选了哪个方案。 */
  const confirmOption = useCallback(
    async (runId: string, optionId: string, imageCount: number): Promise<void> => {
      try {
        await chatApi.confirmRun(runId, optionId, fingerprintOf(runId))
        resolvedRunsRef.current.add(runId)
        toast.success(ta('say.started_count', { count: imageCount }), ta('say.started_hint'))
        events.emit('tasks:changed')
        events.emit('quota:changed')
        await refreshTasks()
      } catch (error) {
        if (error instanceof ApiError && error.code === 'TASK_STATE_CONFLICT') {
          toast.error(ta('say.selection_changed'))
        } else {
          toast.error(errorMessage(error, te))
        }
        throw error
      }
    },
    [fingerprintOf, refreshTasks, toast, te, ta]
  )

  const applyResult = useCallback(
    (result: AnalyzeResult) => {
      setSubmitting(false)
      // 结果已由后端落库为 assistant 消息：这里拉一次消息即可，
      // 绝不在本地再拼一条假消息（否则刷新后会出现重复气泡）。
      void loadMessages(sessionId as string)

      if (result.status === 'confirm' || (result.status === 'preview' && result.options.length > 0)) {
        setNeedsImage(false)
        setAnalysis(null)
        setPending({
          runId: result.run_id,
          fingerprint: result.selection_fingerprint ?? '',
          options: result.options,
          reply: result.reply,
          reason: result.reason,
          state: 'pending',
        })
        return
      }

      setPending(null)

      if (result.status === 'needs_image' || result.requires_image) {
        setAnalysis(null)
        setNeedsImage(true)
        return
      }

      setNeedsImage(false)
      setAnalysis(null)
      if (result.status === 'failed') {
        toast.error(result.reply || ta('say.analyze_failed'))
        return
      }
      if (result.status === 'direct' || result.status === 'completed') {
        toast.success(ta('say.started_count', { count: result.image_count }), ta('say.started_hint'))
        void refreshTasks()
        events.emit('tasks:changed')
        events.emit('quota:changed')
      }
    },
    [loadMessages, refreshTasks, sessionId, toast, ta]
  )

  /** 画布选区提交：走 `/chat/analyze`，实时展示区域判定。 */
  const submitSelection = async (prompt: string) => {
    if (!sessionId || submitting) return
    if (!guardAfford(prices.image_standard)) return
    setSubmitting(true)

    setPending((prev) => {
      if (!prev || prev.state !== 'pending') return prev
      resolvedRunsRef.current.add(prev.runId)
      return { ...prev, state: 'voided' }
    })
    setNeedsImage(false)
    setAnalysis({ steps: [], active: true })

    let payload: ChatSelectionPayload | null = null
    try {
      payload = await buildSelectionPayload(selection)
    } catch (error) {
      setAnalysis(null)
      setSubmitting(false)
      toast.error(errorMessage(error, te))
      return
    }

    analyzeCancelRef.current?.()
    let settled = false
    const failAnalysis = () => {
      setAnalysis(null)
      setSubmitting(false)
      setPending((prev) => (prev && prev.state === 'voided' ? { ...prev, state: 'pending' } : prev))
      if (!cancelledRef.current) {
        toast.error(ta('say.analyze_failed'))
      }
    }
    analyzeCancelRef.current = chatApi.analyzeStream(
      {
        session_id: sessionId,
        content: prompt,
        canvas_id: canvasId,
        selection: payload,
      },
      {
        onStep: (step) => {
          setAnalysis((prev) => ({
            steps: upsertStep(prev?.steps ?? [], step),
            active: true,
          }))
        },
        onResult: (result) => {
          settled = true
          applyResult(result)
        },
        onError: () => {
          settled = true
          failAnalysis()
        },
        onClose: () => {
          if (settled) return
          failAnalysis()
        },
      }
    )
  }

  // --------------------------------------------------------------------- //
  // 纯生图全链路（compose）
  // --------------------------------------------------------------------- //

  const applyComposeResult = useCallback(
    (result: ComposeResult) => {
      setComposing(false)
      void loadMessages(sessionId as string).then(() => setComposeSteps([]))
      void loadRelay()

      if (result.status === 'clarify') {
        toast.info(ta('say.need_direction'), ta('say.need_direction_hint'))
        return
      }
      if (result.status === 'unconfigured') {
        setConfigOpen(true)
        return
      }
      if (result.status === 'failed') {
        // 失败可能是「额度不足 / 并发已满 / 模型格式不对」：把原话放回输入框，别让用户重打
        setInput((prev) => prev || lastComposeRef.current)
        toast.error(result.reply || ta('say.compose_failed'))
        return
      }
      const deduped = result.tasks.length > 0 && result.tasks.every((task) => task.deduped)
      if (deduped) {
        // 幂等命中：不能报「已开始生成」，否则用户会等一张永远不会新出现的图
        toast.info(ta('say.deduped'), ta('say.deduped_hint'))
      } else {
        toast.success(ta('say.started'), ta('say.started_hint'))
      }
      void refreshTasks()
      events.emit('tasks:changed')
      events.emit('quota:changed')
    },
    [loadMessages, loadRelay, refreshTasks, sessionId, toast, ta]
  )

  /** 全链路提交：语义分析 → 澄清 / 提示词 → 生图。返回是否真的发出了请求。 */
  const submitCompose = async (
    content: string,
    allowDegraded = false,
    refsOverride?: ComposerAttachment[],
    mentionIds?: string[]
  ): Promise<boolean> => {
    if (!sessionId || composing) return false
    if (!content.trim()) {
      toast.info(ta('say.retype'), ta('say.retype_hint'))
      return false
    }
    if (!guardAfford(prices.image_standard)) {
      // 额度不足时把用户那句话还回输入框：被拦下的需求不该随之蒸发，
      // 否则充值回来还得凭记忆重打一遍
      updateInput(content)
      return false
    }
    cancelledRef.current = false
    lastComposeRef.current = content
    setComposing(true)
    setComposeSteps([])
    // 新提交让旧的澄清卡作废：不允许两张卡同时可点
    setComposeRunUi((prev) => {
      const next = { ...prev }
      for (const [runId, state] of Object.entries(next)) {
        if (state.state === 'pending') next[runId] = { ...state, state: 'voided' }
      }
      return next
    })

    composeCancelRef.current?.()
    let settled = false
    composeCancelRef.current = chatApi.composeStream(
      {
        session_id: sessionId,
        content,
        canvas_id: canvasId,
        image_refs: [
          ...(refsOverride ?? refs).map((item) => item.id),
          ...(mentionIds ?? []),
        ],
        allow_degraded: allowDegraded,
        model: imageModel,
      },
      {
        onStep: (step) => {
          setComposeSteps((prev) => upsertStep(prev, step))
        },
        onResult: (result) => {
          settled = true
          applyComposeResult(result)
        },
        onError: (message) => {
          settled = true
          setComposing(false)
          // 失败把原话还给用户：输入框已清空时不要让用户重打一遍
          setInput((prev) => prev || content)
          toast.error(ta('say.interrupted'), message)
        },
        onClose: () => {
          if (settled) return
          setComposing(false)
          if (!cancelledRef.current) {
            setInput((prev) => prev || content)
            toast.error(ta('say.interrupted'), ta('say.interrupted_hint'))
          }
        },
      }
    )
    return true
  }

  /** 澄清方案确认：用该方案自带的提示词建任务。 */
  const chooseClarify = async (runId: string, option: ComposeOption) => {
    setComposeRunUi((prev) => ({ ...prev, [runId]: { state: 'choosing', chosenId: option.id } }))
    try {
      await chatApi.confirmRun(runId, option.id, '')
      setComposeRunUi((prev) => ({ ...prev, [runId]: { state: 'done', chosenId: option.id } }))
      toast.success(ta('say.started_direction', { label: option.label }), ta('say.started_hint'))
      events.emit('tasks:changed')
      events.emit('quota:changed')
      await Promise.all([refreshTasks(), loadMessages(sessionId as string)])
    } catch (error) {
      setComposeRunUi((prev) => ({ ...prev, [runId]: { state: 'pending' } }))
      // 错误已在这里 toast，卡片自己会把 loading 退回去，不再向上抛（抛了也没人接）
      toast.error(errorMessage(error, te))
    }
  }

  /**
   * 把 @ 引用图解析成后端资产 id。
   *
   * 画布 / 结果图不一定有资产 id（结果图只有上游 URL、分享进来的图也没登记），
   * 这时回传一次资产库，让图生图链路真的拿得到底图；单张失败不影响其余引用。
   * 解析结果写回 store，下次同一张图再引用就不必重复上传。
   */
  const resolveMentionIds = async (list: ComposerRef[]): Promise<string[]> => {
    const ids: string[] = []
    for (const item of list) {
      if (item.assetId) {
        ids.push(item.assetId)
        continue
      }
      try {
        const response = await fetch(apiUrl(item.url))
        const blob = await response.blob()
        const file = new File([blob], `${item.label}.png`, { type: blob.type || 'image/png' })
        const asset = await assetsApi.upload(file)
        useComposerRefs.setState((state) => ({
          refs: state.refs.map((refItem) =>
            refItem.key === item.key ? { ...refItem, assetId: asset.id, url: asset.url } : refItem
          ),
        }))
        ids.push(asset.id)
      } catch {
        // 拿不到资产就跳过这一张：宁可少一张底图，也不要让整次提交失败
      }
    }
    return ids
  }

  /** 点结果图上的 @ → 作为引用插进输入框（可多选；重复点同一张只聚焦，不堆叠）。 */
  const referenceImage = (url: string) => {
    const added = useComposerRefs.getState().addRef({ key: url, url: apiUrl(url) })
    if (!added) {
      toast.warning(t('input.ref_limit', { max: MAX_COMPOSER_REFS }), t('input.ref_limit_hint'))
    }
  }

  /** 参考图：粘贴 / 拖拽 / 选择，统一先上传成资产再随请求带走。 */
  const handleImageFiles = async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      for (const file of files.slice(0, 4)) {
        const asset = await assetsApi.upload(file)
        setRefs((prev) =>
          prev.length >= 4
            ? prev
            : [...prev, { id: asset.id, url: asset.url, name: file.name }]
        )
      }
    } catch (error) {
      toast.error(ta('say.ref_upload_failed'), errorMessage(error, te))
    } finally {
      setUploading(false)
    }
  }

  const send = async () => {
    const content = input.trim()
    if (!content || !sessionId || submitting || composing) return

    // 并发上限前置拦截：不要等后端 429 才告诉用户
    if (activeCount >= MAX_ACTIVE_TASKS) {
      toast.warning(t('task.limit_title'), t('task.limit_hint', { max: MAX_ACTIVE_TASKS }))
      return
    }

    const hadSelection = hasSelection
    if (hadSelection) {
      // 选区编辑不需要参考图，但也不该把用户刚粘的图静默丢掉
      setInput('')
      clearDraft()
      await submitSelection(content)
      return
    }

    // 只有请求真的发出去才清空输入：被额度/并发拦下时不能吞掉用户写的内容
    // @ 引用图先落地成资产 id，再随原话一起提交（图生图链路靠它拿到底图）
    const mentionIds = await resolveMentionIds(composerRefs)
    const started = await submitCompose(content, false, undefined, mentionIds)
    if (!started) return
    setInput('')
    clearDraft()
    setRefs([])
    clearComposerRefs()
  }

  // --------------------------------------------------------------------- //
  // 首页交接：进入工作室后自动提交那句话（只消费一次）
  // --------------------------------------------------------------------- //
  const submitRef = useRef(submitCompose)
  submitRef.current = submitCompose
  const autoSentRef = useRef(false)

  useEffect(() => {
    if (!initialPrompt || autoSentRef.current || !sessionId) return
    autoSentRef.current = true
    void (async () => {
      const attachments: ComposerAttachment[] = []
      if (initialFiles && initialFiles.length > 0) {
        setUploading(true)
        try {
          for (const file of initialFiles.slice(0, 4)) {
            const asset = await assetsApi.upload(file)
            attachments.push({ id: asset.id, url: asset.url, name: file.name })
          }
          setRefs(attachments)
        } catch (error) {
          toast.error(ta('say.ref_upload_failed'), errorMessage(error, te))
        } finally {
          setUploading(false)
        }
      }
      onInitialConsumed?.()
      await submitRef.current(initialPrompt, false, attachments)
    })()
    // 只在「首页那一句话 / 会话就绪」变化时触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, initialFiles, sessionId])

  const withBusy = async (taskId: string, action: () => Promise<unknown>) => {
    if (busyTaskId) return
    setBusyTaskId(taskId)
    try {
      await action()
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setBusyTaskId(null)
    }
  }

  const handleCancel = (task: GenerationTask) =>
    withBusy(task.id, async () => {
      await generateApi.cancel(task.id)
      void refreshTasks()
      events.emit('quota:changed')
      events.emit('tasks:changed')
      toast.success(t('task.cancelled'), t('task.refunded'))
    })

  const handleRegenerate = (task: GenerationTask) =>
    withBusy(task.id, async () => {
      await submitCompose(task.prompt)
    })

  /** 生成超时后的重试：先停掉旧任务（退回额度），再用同一需求重新出图。 */
  const handleRetryStalled = (task: GenerationTask) =>
    withBusy(task.id, async () => {
      await generateApi.cancel(task.id).catch(() => undefined)
      events.emit('quota:changed')
      await submitCompose(task.prompt)
    })

  /** 只把其中一张放进画布（结果卡图片上的悬浮按钮）。 */
  const handlePlaceImage = async (task: GenerationTask, url: string) => {
    if (placedUrls.includes(url)) return
    await onAddResultToCanvas?.(url, task.id)
    setPlacedUrls(loadPlacedUrls())
    toast.success(t('task.placed_toast'))
  }

  const handleAddToCanvas = async (task: GenerationTask) => {
    const urls = task.result_urls.filter((url) => !placedUrls.includes(url))
    if (urls.length === 0) return
    for (const url of urls) {
      await onAddResultToCanvas?.(url, task.id)
    }
    setPlacedUrls(loadPlacedUrls())
    toast.success(t('task.add_to_canvas'), t('task.result_count', { count: urls.length }))
  }

  const handleCreateSession = async () => {
    try {
      // 新对话 = 新画布：否则新对话里还留着上一轮的图
      const created = await chatApi.createSession({ canvas_id: canvasId, new_canvas: true })
      setSessions((prev) => [created, ...prev])
      onSessionChange(created.id)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleDeleteSession = async (id: string) => {
    try {
      await chatApi.deleteSession(id)
      const next = sessions.filter((s) => s.id !== id)
      setSessions(next)
      if (id === sessionId) onSessionChange(next[0]?.id ?? '')
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  /** 技能库：把骨架写进输入框（{主体} 用当前内容替换，避免让用户对着占位符发呆）。 */
  const insertSkill = (skill: DesignSkill) => {
    const subject = input.trim()
    const scaffold = skill.prompt_scaffold.replace(/\{主体\}/g, subject || '（主体）')
    updateInput(subject && !scaffold.startsWith(subject) ? `${subject}。${scaffold}` : scaffold)
    toast.success(ta('say.skill_applied', { name: skill.name }), ta('say.skill_applied_hint'))
  }

  /**
   * 刷新后恢复待确认卡：assistant 消息附件里带着 `status==='confirm'` 的 skill_run。
   *
   * 确认成功后服务端会把该附件回写成 `status='completed' + chosen_option_id`，
   * 所以正常情况下这里根本匹配不到（已执行过的不会重新变成可点）。
   */
  useEffect(() => {
    if (pending || tasks === null) return
    const candidate = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && pickSkillRun(message.attachments))
    if (!candidate) return
    const run = pickSkillRun(candidate.attachments)
    if (!run || run.status !== 'confirm') return
    if (!run.options?.length) return
    if (resolvedRunsRef.current.has(run.run_id) || restoredRunsRef.current.has(run.run_id)) return
    const at = timeOf(candidate.created_at)
    if (orderedTasks.some((task) => timeOf(task.created_at) >= at)) return
    restoredRunsRef.current.add(run.run_id)
    setPending({
      runId: run.run_id,
      fingerprint: run.selection_fingerprint ?? '',
      options: run.options,
      reply: candidate.content,
      reason: run.reason,
      state: 'pending',
    })
  }, [messages, tasks, orderedTasks, pending])

  const isEmpty =
    !messagesLoading &&
    timeline.length === 0 &&
    !composing &&
    !analysis &&
    !pending &&
    composeSteps.length === 0

  const analysisActive = Boolean(analysis?.active)
  /**
   * 画布上有**真实的区域选区**：这句话应当被当成「编辑需求」而不是从零生成。
   *
   * 必须同时满足「有区域」与「每个区域都写了改法」——
   * 只框了没写字时不算编辑需求，否则用户打的普通描述会被当成区域指令送进 analyze。
   */
  const hasSelection =
    (selection?.regions?.length ?? 0) > 0 &&
    (selection?.regions ?? []).every((region) => (region.prompt ?? '').trim().length > 0)
  const configured = relay?.configured ?? false

  /** 停止当前这次分析（输入框停止键 / 等待条「停止」共用）。 */
  const stopRun = () => {
    cancelledRef.current = true
    composeCancelRef.current?.()
    analyzeCancelRef.current?.()
    setComposing(false)
    setSubmitting(false)
    setAnalysis(null)
  }

  /**
   * 超时后的「重试」：先停掉旧流，等 composing 真正落回 false 再重发。
   * 不能在同一个回调里直接调 submitCompose——那时闭包里的 composing 仍是 true，会被挡回。
   */
  const [retryText, setRetryText] = useState<string | null>(null)
  useEffect(() => {
    if (!retryText || composing) return
    const text = retryText
    setRetryText(null)
    void submitCompose(text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryText, composing])

  /**
   * 接收画布编辑层的「去创作」交接单。
   *
   * 编辑层只负责框选与写需求；真正生成统一走这条链路（AI 分析 → 提示词 → 出图），
   * 这样两条入口的产出、计费、失败处理完全一致。
   */
  useEffect(() => {
    return useComposerHandoff.subscribe((state) => {
      if (!state.pending) return
      const { text, files } = useComposerHandoff.getState().consume()
      if (!text.trim()) return
      setInput(text)
      void (async () => {
        let attachments: ComposerAttachment[] = []
        if (files.length > 0) {
          try {
            const uploaded = await Promise.all(files.map((file) => assetsApi.upload(file)))
            attachments = uploaded.map((asset) => ({
              id: asset.id,
              url: asset.url,
              name: asset.source_prompt || ta('ui.canvas_selection'),
            }))
            setRefs(attachments)
          } catch (error) {
            toast.error(ta('say.ref_upload_failed'), errorMessage(error, te))
          }
        }
        await submitCompose(text, false, attachments)
      })()
    })
  }, [submitCompose, te, toast, ta])

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* 会话条：品牌 / 新建 / 收起已由外层 Agent 面板头承担，这里只回答两件事——
          「当前是哪段对话」与「Agent 现在连没连上、手上有几张图在跑」。 */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 px-3">
        <p className="min-w-0 flex-1 truncate text-caption text-text-tertiary">
          {sessions.find((item) => item.id === sessionId)?.title || t('panel_title')}
        </p>

        {activeCount > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-micro font-medium tabular-nums text-accent-ink"
            title={t('header.active_tasks', { count: activeCount })}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-strong" />
            {t('header.active_tasks', { count: activeCount })}
          </span>
        )}

        <button
          type="button"
          onClick={() => setConfigOpen(true)}
          title={
            configured
              ? t('header.relay_connected', {
                  name: `${relay?.provider_name || ''} ${relay?.model || ''}`.trim(),
                })
              : t('header.relay_configure')
          }
          aria-label={t('header.relay_configure')}
          className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xs text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Settings2 size={15} />
          <span
            className={
              configured
                ? 'absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-success'
                : 'absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warning'
            }
          />
        </button>
      </div>

      {!online && (
        <div className="shrink-0 bg-warning-subtle px-3 py-1 text-caption text-warning">
          {t('network.offline')}
        </div>
      )}

      {!configured && relay !== null && (
        <>
        <button
          type="button"
          onClick={() => setConfigOpen(true)}
          className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-sm bg-warning-subtle px-2.5 py-1.5 text-left text-micro text-warning transition-opacity hover:opacity-90"
        >
          <Settings2 size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{ta('ui.relay_missing')}</span>
        </button>
        </>
      )}

      <div className="relative min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-3 px-3 pb-4">
            {/* 会话加载：给骨架而不是空白，让"正在加载"可被感知 */}
            {messagesLoading && timeline.length === 0 && (
              <div className="flex flex-col gap-3 pt-2">
                <div className="ml-auto h-12 w-3/5 animate-pulse rounded-md bg-bg-subtle" />
                <div className="h-24 w-4/5 animate-pulse rounded-md bg-bg-subtle" />
                <div className="ml-auto h-10 w-2/5 animate-pulse rounded-md bg-bg-subtle" />
                <div className="mt-1 flex items-center gap-2 text-caption text-text-tertiary">
                  <Loader2 size={13} className="animate-spin" />
                  {ta('ui.loading_chat')}
                </div>
              </div>
            )}

            {isEmpty && (
              <AgentWelcome
                examples={[t('empty.example_1'), t('empty.example_2'), t('empty.example_3')]}
                onPick={updateInput}
              />
            )}

            {timeline.map((entry) => {
              if (entry.kind === 'message') {
                const run = pickSkillRun(entry.message.attachments)
                const compose = pickComposeRun(entry.message.attachments)
                const images = pickImages(entry.message.attachments)
                const composeUi = compose ? composeRunUi[compose.run_id] : undefined
                const clarifyState: ClarifyState =
                  composeUi?.state ??
                  (compose?.chosen_option_id ? 'done' : compose?.status === 'clarify' ? 'pending' : 'pending')
                // 分析轨迹挂在 AI 回复上（默认折叠）：用户随时能回看「Agent 是怎么想的」
                const traceSteps =
                  entry.message.role === 'assistant'
                    ? compose?.steps.length
                      ? compose.steps
                      : run && Array.isArray(run.steps) && run.steps.length
                        ? run.steps
                        : undefined
                    : undefined
                return (
                  <div key={entry.message.id} className="flex flex-col gap-2">
                    <ChatMessage
                      message={entry.message}
                      images={images}
                      traceSteps={traceSteps}
                      skillId={compose?.skill_id || null}
                      skillName={run?.skill?.name || null}
                    />
                    {run && (
                      <div className="pl-[30px]">
                        <SkillRunCard
                          run={run}
                          onConfirm={
                            pending?.runId === run.run_id ||
                            resolvedRunsRef.current.has(run.run_id)
                              ? undefined
                              : (runId, optionId) =>
                                  confirmOption(
                                    runId,
                                    optionId,
                                    run.options.find((item) => item.id === optionId)?.image_count ??
                                      1
                                  )
                          }
                        />
                      </div>
                    )}
                    {compose && compose.status === 'clarify' && (
                      <div className="flex flex-col gap-2 pl-[30px]">
                        <ClarifyCard
                          runId={compose.run_id}
                          reply={compose.reply}
                          options={compose.options ?? []}
                          state={clarifyState}
                          chosenId={compose.chosen_option_id ?? composeUi?.chosenId}
                          onChoose={(optionId) => {
                            const option = (compose.options ?? []).find(
                              (item) => item.id === optionId
                            )
                            if (!option) return Promise.reject(new Error('option missing'))
                            return chooseClarify(compose.run_id, option)
                          }}
                          onCustom={
                            clarifyState === 'pending'
                              ? (text) => {
                                  // 用户自己给的方向 = 原话 + 补充，作为一句新需求重新分析
                                  const base = (compose.content || lastComposeRef.current || '').trim()
                                  void submitCompose(base ? `${base}。${text}` : text)
                                }
                              : undefined
                          }
                        />
                      </div>
                    )}
                    {compose && compose.status === 'unconfigured' && (
                      <div className="ml-[30px] rounded-md bg-warning-subtle/60 px-3 py-2.5 shadow-sheet ring-1 ring-inset ring-warning/25">
                        <p className="text-caption font-medium text-text">{ta('ui.relay_title')}</p>
                        <p className="mt-0.5 text-micro text-text-tertiary">{ta('ui.relay_desc')}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="primary"
                            className="h-7 px-2.5 text-caption"
                            onClick={() => setConfigOpen(true)}
                          >
                            <Settings2 size={12} /> {ta('ui.relay_go')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2.5 text-caption"
                            onClick={() =>
                              void submitCompose(compose.content || lastComposeRef.current, true)
                            }
                          >
                            {ta('ui.relay_template')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              }
              // 生成结果直接以 AI 气泡落在对话里：左侧头像 + 结果卡，
              // 不再另设侧栏大图位，也不再回显生图提示词。
              return (
                <div key={entry.task.id} className="cs-bubble-in-left flex pl-[30px]">
                  <div className="min-w-0 flex-1">
                    <GenerationResultCard
                      task={entry.task}
                      placedUrls={placedUrls}
                      busy={busyTaskId === entry.task.id || composing}
                      offline={!online}
                      onAddToCanvas={handleAddToCanvas}
                      onPlaceImage={(item, url) => void handlePlaceImage(item, url)}
                      onRetryStalled={handleRetryStalled}
                      onCancel={handleCancel}
                      onRegenerate={handleRegenerate}
                      onPreview={(task, url) => setPreview({ url, prompt: task.prompt })}
                      onReference={referenceImage}
                    />
                  </div>
                </div>
              )
            })}

            {/* 生成过程：只留一行轻量「正在思考…」，完成后随结果一起消失 */}
            {(composing || analysisActive || composeSteps.length > 0) && (
              <ThinkingBubble
                steps={composeSteps.length > 0 ? composeSteps : (analysis?.steps ?? [])}
                offline={!online}
                onStop={stopRun}
                onRetry={
                  composing && lastComposeRef.current
                    ? () => {
                        const text = lastComposeRef.current
                        stopRun()
                        setRetryText(text)
                      }
                    : undefined
                }
              />
            )}

            {/* 待确认方案：只允许一个，且绝不到点自动执行 */}
            {pending && (
              <div className="pl-[30px]">
                <ConfirmCountCard
                  runId={pending.runId}
                  fingerprint={pending.fingerprint}
                  options={pending.options}
                  reply={pending.reply}
                  reason={pending.reason}
                  state={pending.state}
                  chosenId={pending.chosenId}
                  onChoose={async (optionId) => {
                    const count =
                      pending.options.find((item) => item.id === optionId)?.image_count ?? 1
                    setPending((prev) => (prev ? { ...prev, state: 'choosing' } : prev))
                    try {
                      await confirmOption(pending.runId, optionId, count)
                      setPending((prev) =>
                        prev ? { ...prev, state: 'done', chosenId: optionId } : prev
                      )
                      void loadMessages(sessionId as string)
                    } catch {
                      setPending((prev) =>
                        prev ? { ...prev, state: 'pending', chosenId: undefined } : prev
                      )
                      throw new Error('confirm failed')
                    }
                  }}
                />
              </div>
            )}

            {/* 缺少底图：给一条明确的下一步，不要只留一句错误文字 */}
            {needsImage && (
              <div className="ml-[30px] rounded-md bg-surface px-3 py-2.5 shadow-sheet ring-1 ring-inset ring-border-faint">
                <div className="flex items-start gap-1.5">
                  <span className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                  <div className="min-w-0 flex-1">
                    <p className="text-caption font-medium text-text">{ta('ui.need_image_title')}</p>
                    <p className="mt-1 text-micro leading-snug text-text-tertiary">
                      {ta('ui.need_image_desc')}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {onFocusCanvas && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-caption"
                      onClick={onFocusCanvas}
                    >
                      {ta('ui.need_image_canvas')}
                    </Button>
                  )}
                  {onPickAsset && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-caption"
                      onClick={onPickAsset}
                    >
                      <Images size={13} /> {ta('ui.from_assets')}
                    </Button>
                  )}
                  {onUpload && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2.5 text-caption"
                      onClick={onUpload}
                    >
                      <Upload size={13} /> {ta('ui.upload_local')}
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div ref={scrollAnchorRef} />
          </div>
        </ScrollArea>

        {showJump && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-surface-raised px-3 py-1.5 text-caption text-text-secondary shadow-lift ring-1 ring-inset ring-border-faint hover:bg-surface-hover"
          >
            <ArrowDown size={13} /> {t('scroll.back_to_latest')}
            {newCount > 0 && (
              <span className="ml-0.5 rounded-full bg-accent px-1.5 py-0.5 text-micro font-semibold leading-none text-accent-ink">
                {newCount}
              </span>
            )}
          </button>
        )}
      </div>

      <ChatTextarea
        value={input}
        onChange={updateInput}
        onSend={send}
        onStop={stopRun}
        sending={composing || analysisActive}
        submitting={submitting || composing || analysisActive}
        attachments={refs}
        uploading={uploading}
        onRemoveAttachment={(id) => setRefs((prev) => prev.filter((item) => item.id !== id))}
        mentions={composerRefs.map((item) => ({ key: item.key, url: item.url, label: item.label }))}
        onRemoveMention={removeComposerRef}
        onImageFiles={(files) => void handleImageFiles(files)}
        focusSignal={refFocusSignal}
        aboveSlot={
          composing || analysisActive ? null : (
            <PromptGuide
              value={input}
              onChange={updateInput}
              hasReferences={refs.length > 0 || composerRefs.length > 0 || hasSelection}
            />
          )
        }
        topRightSlot={
          <PolishPopover
            text={input}
            scene="composer"
            onApply={(next) => updateInput(next)}
            disabled={!input.trim()}
          />
        }
        leftSlot={
          <button
            type="button"
            onClick={() => setSkillOpen(true)}
            title={ta('ui.skill_library')}
            aria-label={ta('ui.skill_library')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xs text-text-tertiary transition-colors hover:bg-brand-subtle hover:text-brand-text"
          >
            <LibraryBig size={15} />
          </button>
        }
        attachSlot={
          onUpload || onPickAsset ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={ta('ui.add_reference')}>
                  <Plus size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-44">
                {onUpload && (
                  <DropdownMenuItem onClick={onUpload}>
                    <Upload size={15} /> {ta('ui.upload_reference')}
                  </DropdownMenuItem>
                )}
                {onPickAsset && (
                  <DropdownMenuItem onClick={onPickAsset}>
                    <Images size={15} /> {ta('ui.from_assets')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
        rightSlot={
          /* 生图模型选择：贴在输入框底栏、发送键左边。
             放在面板顶部时它离"我要生成什么"太远，而且和标题抢一行。 */
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={ta('ui.pick_model')}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-micro font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
              >
                <Sparkles size={11} />
                {IMAGE_MODELS.find((item) => item.id === imageModel)?.short ?? 'GPT 2.0'}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-60">
              {IMAGE_MODELS.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onClick={() => chooseModel(item.id)}
                  className="flex flex-col items-start gap-0"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="text-caption text-text">{item.label}</span>
                    {imageModel === item.id && <Check size={12} className="ml-auto text-brand-text" />}
                  </span>
                  <span className="font-mono text-micro text-text-faint">{item.id}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <AIConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        onChanged={() => {
          void loadRelay()
        }}
      />
      <SkillLibraryPanel open={skillOpen} onOpenChange={setSkillOpen} onPick={insertSkill} />

      {preview && (
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-scrim p-6"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            aria-label={ta('ui.close')}
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-scrim-text/15 text-scrim-text backdrop-blur-sm transition-colors hover:bg-scrim-text/25"
          >
            <X size={18} />
          </button>
          {/*
            预览只放图片本身（提示词是生成时的中间信息，不进预览）。
            figure 用 flex 居中 + 图片 max-w/max-h 双约束：只写 max-h 时宽图会
            横向溢出被裁掉两侧，看上去就是「图片没居中」。
          */}
          <figure
            className="flex max-h-full max-w-full items-center justify-center"
            onClick={(event) => event.stopPropagation()}
          >
            <img
              src={preview.url}
              alt={preview.prompt.slice(0, 40)}
              className="max-h-[78vh] max-w-[86vw] rounded-xs bg-mat object-contain shadow-lg"
            />
          </figure>
        </div>
      )}
    </div>
  )
}
