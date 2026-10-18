import { api } from './client'
import { getToken } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { ChatMessage, ChatSession } from '@/types/models'

export interface ChatStreamHandlers {
  onDelta: (delta: string, demo: boolean) => void
  onDone: (info: { demo: boolean; errorCode?: string }) => void
  signal?: AbortSignal
}

/** 一个编排步骤的状态（服务端 Skill 轨迹）。 */
export interface SkillStepState {
  id: string
  title: string
  detail: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed'
  elapsed_ms: number
}

/** Skill 声明（步骤 + 编排规则），用于向用户展示 AI 按什么规则执行。 */
export interface SkillDefinition {
  id: string
  name: string
  description: string
  steps: Array<{ id: string; title: string; detail: string }>
  rules: string[]
}

/** 待用户选择的一个方案。 */
export interface SkillOption {
  id: string
  label: string
  description: string
  image_count: number
}

/** 产出明细（后端 estimate_outputs 的结果，用于「1 张整图 + 2 张素材」这种分组描述）。 */
export interface SkillOutputGroup {
  group?: string
  label?: string
  count?: number
  handler?: string
  description?: string
  [key: string]: unknown
}

/** 分析命中的编排规则（决定「为什么是这个数量」的那一条）。 */
export type SkillRuleHit = 'explicit_count' | 'structure' | 'ambiguous' | 'needs_image'

/**
 * 需求分析结果（完整形态）：SSE `result` 事件与消息附件 `skill_run` 是同一套字段。
 * 两者共用这个类型，避免前端出现「实时卡」和「历史卡」两套结构。
 */
export interface AnalyzeResult {
  run_id: string
  message_id: string
  user_message_id: string
  skill: SkillDefinition
  status: 'direct' | 'confirm' | 'preview' | 'needs_image' | 'completed' | 'failed'
  image_count: number
  confidence: number
  reason: string
  reply: string
  steps: SkillStepState[]
  options: SkillOption[]
  tasks: Array<{ id: string; type: string; status: string; prompt: string; cost: number }>
  requires_image: boolean
  demo: boolean
  /** 命中的规则（老数据可能没有） */
  rule_hit?: SkillRuleHit | string
  /** 产出明细分组 */
  outputs?: SkillOutputGroup[]
  /** 选区版本号（用于提示「选区已经变了」） */
  selection_revision?: number
  /** 分析时那片选区的指纹（确认方案时必须回传，服务端据此判断计划是否作废） */
  selection_fingerprint?: string
  target_id?: string | null
  canvas_id?: string | null
  task_ids?: string[]
}

/**
 * assistant 消息 attachments 里的 `skill_run` 附件。
 * 历史消息靠它渲染步骤轨迹与「待选方案」，刷新后依然可追溯、可继续选择。
 */
export interface SkillRunAttachment {
  type: 'skill_run'
  run_id: string
  skill: SkillDefinition
  status: string
  steps: SkillStepState[]
  image_count: number
  confidence: number
  reason: string
  options: SkillOption[]
  /** 老数据可能缺这两个字段 */
  requires_image?: boolean
  rule_hit?: SkillRuleHit | string
  outputs?: SkillOutputGroup[]
  task_ids?: string[]
  /**
   * 用户最终选定的方案 id。
   * 确认成功后服务端会回写这条附件（status→completed + chosen_option_id），
   * 所以刷新页面也能看出「刚才选的是哪一个」，而不是又变回可点。
   */
  chosen_option_id?: string
  selection_revision?: number
  selection_fingerprint?: string
  target_id?: string | null
  canvas_id?: string | null
}

/** 从消息附件里挑出 skill_run（非该类型返回 null）。 */
export function pickSkillRun(attachments: unknown): SkillRunAttachment | null {
  if (!Array.isArray(attachments)) return null
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as { type?: unknown; run_id?: unknown }
    if (candidate.type !== 'skill_run' || typeof candidate.run_id !== 'string') continue
    return item as SkillRunAttachment
  }
  return null
}

export interface ChatSelectionPayload {
  asset_id?: string | null
  /** 画笔/套索掩码图（已上传的资产 id）：有掩码时上游只重绘这块像素。 */
  mask_asset_id?: string | null
  width?: number
  height?: number
  has_doodle?: boolean
  regions: Array<{
    index: number
    region: { x: number; y: number; w: number; h: number }
    path?: Array<{ x: number; y: number }> | null
    prompt?: string
    handler?: string
  }>
}

/** ------------------------------------------------------------------ */
/** 纯生图全链路（compose）：需求分析 → 歧义澄清 → 方案推导 → 提示词 */
/** ------------------------------------------------------------------ */

/** 一个思考步骤：`items` 是该阶段的推理要点（比一句 detail 更能说明白）。 */
export interface ComposeStep {
  id: string
  title: string
  detail: string
  status: 'pending' | 'running' | 'done' | 'skipped' | 'blocked' | 'failed'
  elapsed_ms: number
  items?: string[]
}

/** 澄清时给出的一个方向（带完整提示词，选中即用）。 */
export interface ComposeOption {
  id: string
  label: string
  description: string
  prompt: string
  size: string
  image_count: number
}

/** 全链路结果：SSE result 与消息附件共用同一套字段。 */
export interface ComposeResult {
  run_id: string
  message_id: string
  user_message_id?: string
  status: 'direct' | 'clarify' | 'unconfigured' | 'failed'
  reply: string
  steps: ComposeStep[]
  options: ComposeOption[]
  tasks: Array<{
    id: string
    type: string
    status: string
    prompt: string
    cost: number
    /** 幂等命中：复用了刚建过的任务，本次没有重复扣额度 */
    deduped?: boolean
  }>
  final_prompt: string
  negative?: string
  size?: string
  skill_id?: string
  prompt_source: 'relay' | 'template' | 'none'
  degraded: boolean
  image_refs?: string[]
  error_code?: string
  action?: { type: string }
  relay?: { configured: boolean; source?: string; provider?: string; model?: string }
}

/** assistant 消息附件里的 compose_run 快照（刷新后可还原思考链路）。 */
export interface ComposeRunAttachment {
  type: 'compose_run'
  run_id: string
  status: string
  reply: string
  /** 用户原话（未配置中转站时「用本地模板先试一次」要原样重发） */
  content?: string
  steps: ComposeStep[]
  final_prompt: string
  negative?: string
  size?: string
  skill_id?: string
  prompt_source?: string
  degraded?: boolean
  options?: ComposeOption[]
  tasks?: Array<{ id: string; type: string; status: string; prompt: string; cost: number }>
  task_ids?: string[]
  chosen_option_id?: string
}

export function pickComposeRun(attachments: unknown): ComposeRunAttachment | null {
  if (!Array.isArray(attachments)) return null
  for (const item of attachments) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as { type?: unknown }
    if (candidate.type !== 'compose_run') continue
    return item as ComposeRunAttachment
  }
  return null
}

/** 消息里附带的图片（上传/粘贴的参考图）。 */
export interface MessageImageAttachment {
  type: 'image'
  asset_id: string
  url: string
  name?: string
}

export function pickImages(attachments: unknown): MessageImageAttachment[] {
  if (!Array.isArray(attachments)) return []
  return attachments.filter(
    (item): item is MessageImageAttachment =>
      Boolean(item) && typeof item === 'object' && (item as { type?: string }).type === 'image'
  )
}

export const chatApi = {
  listSessions: (canvasId?: string) =>
    api.get<ChatSession[]>(`/chat/sessions${canvasId ? `?canvas_id=${canvasId}` : ''}`),
  getSession: (id: string) => api.get<ChatSession>(`/chat/sessions/${id}`),
  createSession: (payload: { canvas_id?: string; title?: string; new_canvas?: boolean }) =>
    api.post<ChatSession>('/chat/sessions', payload),
  updateSession: (id: string, title: string) =>
    api.patch<ChatSession>(`/chat/sessions/${id}`, { title }),
  bindCanvas: (id: string, canvasId: string) =>
    api.patch<ChatSession>(`/chat/sessions/${id}`, { canvas_id: canvasId }),
  deleteSession: (id: string) => api.del<unknown>(`/chat/sessions/${id}`),
  /** 删除单条消息（软删） */
  deleteMessage: (id: string) => api.del<{ deleted: string }>(`/chat/messages/${id}`),
  /** 批量删除消息（「全选」后用） */
  deleteMessages: (ids: string[]) =>
    api.post<{ deleted: number }>('/chat/messages/batch-delete', { ids }),
  listMessages: (sessionId: string, query: PageQuery = {}) =>
    api.get<PageData<ChatMessage>>(
      `/chat/sessions/${sessionId}/messages?page=${query.page ?? 1}&size=${query.size ?? 100}`
    ),

  /** Skill 声明：编排步骤与规则（可追溯）。 */
  skills: () => api.get<{ skills: SkillDefinition[] }>('/chat/skills'),

  /**
   * 用户选定方案后执行。
   *
   * `fingerprint` 必须是**分析时那片选区**的指纹（后端随 skill_run 附件一起返回）。
   * 服务端拿它和 run.plan 里的指纹比对：不一致说明选区在确认前又变了，
   * 旧计划直接作废（409 TASK_STATE_CONFLICT），而不是照着过期方案去花额度。
   */
  confirmRun: (runId: string, optionId: string, fingerprint: string) =>
    api.post<{ run_id: string; status: string; task_ids: string[] }>(
      `/chat/runs/${runId}/confirm`,
      { option_id: optionId, selection_fingerprint: fingerprint }
    ),

  /**
   * 需求分析中转站：SSE 实时返回每一步的判定过程。
   * 返回取消函数。
   */
  analyzeStream: (
    payload: {
      session_id: string
      content: string
      canvas_id?: string
      selection?: ChatSelectionPayload | null
      auto_execute?: boolean
    },
    handlers: {
      onStep: (step: SkillStepState) => void
      onResult: (result: AnalyzeResult) => void
      onError: (message: string) => void
      /**
       * 流正常结束（无论是否收到 result）。
       * 没有这个回调时，服务端中途断开连接（还没发 result 就关流）会让调用方
       * 永久停在「分析中」——按钮一直禁用，等于卡死。
       */
      onClose?: () => void
    }
  ): (() => void) => {
    const controller = new AbortController()
    const run = async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }
        const token = getToken()
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || '/api'}/chat/analyze`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`分析失败（HTTP ${res.status}）`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index = buffer.indexOf('\n\n')
          while (index !== -1) {
            const rawEvent = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const dataStr = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('')
            if (dataStr) {
              try {
                const obj = JSON.parse(dataStr) as {
                  event?: 'step' | 'result'
                  step?: SkillStepState
                  result?: AnalyzeResult
                }
                if (obj.event === 'step' && obj.step) handlers.onStep(obj.step)
                if (obj.event === 'result' && obj.result) handlers.onResult(obj.result)
              } catch {
                /* 忽略半包 */
              }
            }
            index = buffer.indexOf('\n\n')
          }
        }
        handlers.onClose?.()
      } catch (error) {
        // 取消同样要回调 onClose：否则调用方会停在「分析中」，按钮永久禁用
        if ((error as Error).name === 'AbortError') handlers.onClose?.()
        else handlers.onError((error as Error).message || '分析失败')
      }
    }
    void run()
    return () => controller.abort()
  },

  /**
   * 纯生图全链路：SSE 实时返回「读懂需求 → 歧义检查 → 推导方案 → 生成提示词 → 提交」。
   * 返回取消函数。
   */
  composeStream: (
    payload: {
      session_id: string
      content: string
      canvas_id?: string
      image_refs?: string[]
      selection?: ChatSelectionPayload | null
      /** 用户显式同意「未配置中转站时用本地模板先试一次」 */
      allow_degraded?: boolean
      /** 生图模型：gpt-image-2 / gpt-image-2.5 */
      model?: string
    },
    handlers: {
      onStep: (step: ComposeStep) => void
      onResult: (result: ComposeResult) => void
      onError: (message: string) => void
      onClose?: () => void
    }
  ): (() => void) => {
    const controller = new AbortController()
    const run = async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }
        const token = getToken()
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || '/api'}/chat/compose`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`需求分析失败（HTTP ${res.status}）`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index = buffer.indexOf('\n\n')
          while (index !== -1) {
            const rawEvent = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const dataStr = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('')
            if (dataStr) {
              try {
                const obj = JSON.parse(dataStr) as {
                  event?: 'step' | 'result'
                  step?: ComposeStep
                  result?: ComposeResult
                }
                if (obj.event === 'step' && obj.step) handlers.onStep(obj.step)
                if (obj.event === 'result' && obj.result) handlers.onResult(obj.result)
              } catch {
                /* 忽略半包 */
              }
            }
            index = buffer.indexOf('\n\n')
          }
        }
        handlers.onClose?.()
      } catch (error) {
        // 用户主动取消（切会话 / 点停止）也要收尾：否则调用方的 composing 永远为 true，
        // 输入框会一直停在「提交中」，表现为发送键永久禁用。
        if ((error as Error).name === 'AbortError') handlers.onClose?.()
        else handlers.onError((error as Error).message || '需求分析失败')
      }
    }
    void run()
    return () => controller.abort()
  },

  /** 发送消息并以 SSE 接收流式回复。返回取消函数。 */
  streamMessage: (
    payload: {
      session_id: string
      content: string
      canvas_id?: string
      image_refs?: string[]
    },
    handlers: ChatStreamHandlers
  ): (() => void) => {
    const controller = new AbortController()
    const signal = handlers.signal ?? controller.signal
    const run = async () => {
      let demo = false
      let errorCode: string | undefined
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }
        const token = getToken()
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || '/api'}/chat/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        })
        if (!res.ok || !res.body) throw new Error(`对话失败（HTTP ${res.status}）`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index = buffer.indexOf('\n\n')
          while (index !== -1) {
            const rawEvent = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const dataStr = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('')
            if (dataStr) {
              try {
                const obj = JSON.parse(dataStr) as {
                  delta?: string
                  done?: boolean
                  demo?: boolean
                  error_code?: string
                }
                if (obj.demo) demo = true
                if (obj.delta) handlers.onDelta(obj.delta, demo)
                if (obj.done) {
                  errorCode = obj.error_code
                  handlers.onDone({ demo, errorCode })
                }
              } catch {
                /* ignore */
              }
            }
            index = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          handlers.onDone({ demo, errorCode: 'UPSTREAM_ERROR' })
        }
      }
    }
    void run()
    return () => controller.abort()
  },
}
