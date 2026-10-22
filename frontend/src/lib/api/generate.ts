import { api } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { GenerationTask } from '@/types/models'

export interface GenerateImagePayload {
  prompt: string
  model?: string
  size?: string
  quality?: string
  n?: number
  session_id?: string
  canvas_id?: string
  params?: Record<string, unknown>
}

/** 归一化选区（相对原图 0-1）。 */
export interface EditRegionBox {
  x: number
  y: number
  w: number
  h: number
}

/** 一条结构化编辑操作：改哪里（region）+ 怎么改（handler）+ 改成什么（prompt）。 */
export interface EditOpPayload {
  region: EditRegionBox
  /** 自由选区（套索）多边形顶点；有值时后端按多边形生成掩码 */
  path?: Array<{ x: number; y: number }> | null
  /** 能力 id（由后端能力注册表提供，可按需扩展） */
  handler: string
  prompt: string
  /** fine=精细修改（默认）；rebuild=重新生成 */
  intensity?: 'fine' | 'rebuild'
}

/** 一种可用编辑能力（后端注册表驱动，前端不写死）。 */
export interface EditCapability {
  id: string
  label: string
  description: string
  /** composite=与原图同尺寸整图；sprite=独立透明素材 */
  output: 'composite' | 'sprite'
  /** 是否每个区域各产出一张 */
  per_region: boolean
  billable: boolean
  /** 带内置提示词的能力（抠图/去物/增强）不需要用户再写指令 */
  has_builtin_prompt: boolean
}

/** 产出预估条目。 */
export interface OutputPreview {
  handler: string
  label: string
  kind: 'composite' | 'sprite'
  count: number
  region_indexes: number[]
}

/** 意图分析结果。 */
export interface PlanResult {
  reply: string
  ops: Array<{
    region_index: number
    region: EditRegionBox
    handler: string
    prompt: string
    intensity: string
  }>
  outputs: OutputPreview[]
  summary: string
  demo: boolean
  /** model=模型真的给了可用结果；fallback=模型失败或结果全部无效，不得自动回填 */
  plan_source?: 'model' | 'fallback'
  /** 模型给出的结果是否全部无效（前端据此进「补充描述」态，而不是弹 toast） */
  fabricated?: boolean
  /** 被丢弃的区域编号（模型臆造的编号） */
  dropped_indexes?: number[]
  region_count?: number
  selection_fingerprint?: string
  thinking?: string[]
  model?: string
}

export interface GenerateEditPayload {
  prompt: string
  model?: string
  size?: string
  base_asset_id?: string
  session_id?: string
  canvas_id?: string
  file?: File
  mask?: File
  guide?: File
  /** 归一化选区（单个或多个），用于服务端"选区外严格不变"的合成保真 */
  region?: EditRegionBox | EditRegionBox[]
  /** 结构化编辑操作（推荐）：能力注册表驱动，产出数量自动规划 */
  ops?: EditOpPayload[]
  /** 'transparent' = 就地透明化（同样提交给上游模型执行，按编辑单价计费） */
  mode?: string
}

export interface TaskListQuery extends PageQuery {
  canvas_id?: string
  session_id?: string
  status?: string
}

export const generateApi = {
  image: (payload: GenerateImagePayload, idempotencyKey?: string) =>
    api.post<GenerationTask>('/generate/image', payload, { idempotencyKey }),

  edit: (payload: GenerateEditPayload, idempotencyKey?: string) => {
    const form = new FormData()
    form.append('prompt', payload.prompt)
    if (payload.model) form.append('model', payload.model)
    if (payload.size) form.append('size', payload.size)
    if (payload.base_asset_id) form.append('base_asset_id', payload.base_asset_id)
    if (payload.session_id) form.append('session_id', payload.session_id)
    if (payload.canvas_id) form.append('canvas_id', payload.canvas_id)
    if (payload.file) form.append('file', payload.file)
    if (payload.mask) form.append('mask', payload.mask)
    if (payload.guide) form.append('guide', payload.guide)
    if (payload.region) form.append('region', JSON.stringify(payload.region))
    if (payload.ops?.length) form.append('ops', JSON.stringify(payload.ops))
    if (payload.mode) form.append('edit_mode', payload.mode)
    return api.post<GenerationTask>('/generate/edit', form, { idempotencyKey })
  },

  /** 把自然语言需求解析为结构化编辑计划（只分析，不创建任务、不计费）。 */
  plan: (payload: { message: string; regions?: unknown[]; canvas_id?: string }) =>
    api.post<PlanResult>('/generate/plan', payload),

  /** 拉取当前可用的编辑能力清单（注册表驱动）。 */
  capabilities: () =>
    api.get<{ handlers: EditCapability[] }>('/generate/capabilities'),

  listTasks: (query: TaskListQuery = {}) => {
    const params = new URLSearchParams()
    params.set('page', String(query.page ?? 1))
    params.set('size', String(query.size ?? 20))
    if (query.canvas_id) params.set('canvas_id', query.canvas_id)
    if (query.session_id) params.set('session_id', query.session_id)
    if (query.status) params.set('status', query.status)
    return api.get<PageData<GenerationTask>>(`/generate/tasks?${params.toString()}`)
  },

  getTask: (id: string) => api.get<GenerationTask>(`/generate/tasks/${id}`),
  pause: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/pause`),
  resume: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/resume`),
  cancel: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/cancel`),
  /**
   * 重试失败/超时/已取消的任务。
   *
   * 与「重新生成」不同：这个走服务端复用原任务的 params（模型/尺寸/质量/编辑算子），
   * 不再跑一遍 LLM 规划。用户已经看过一次结果了，他要的是「同样的东西再来一次」，
   * 不是「重新理解我的需求」——而且省掉一次模型调用，快得多。
   */
  retry: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/retry`, {}),
  markSeen: (id: string) => api.post<GenerationTask>(`/generate/tasks/${id}/seen`),
}
