// 后端实体类型（与 backend schemas 对齐）

export type UserRole = 'admin' | 'pro' | 'user'
export type UserStatus = 'pending_verification' | 'active' | 'banned'

export interface User {
  id: string
  email: string
  role: UserRole
  status: UserStatus
  display_name: string
  locale: string
  theme: string
  balance: number
  email_verified_at?: string | null
  last_login_at?: string | null
  created_at?: string | null
  /** 引导状态：完成前前端会引导去 /onboarding */
  persona_key?: string
  onboarding_completed_at?: string | null
  active_team_id?: string | null
}

export interface CanvasProject {
  id: string
  owner_id: string
  team_id?: string | null
  visibility?: 'private' | 'team'
  can_edit?: boolean
  name: string
  description: string
  thumbnail_url?: string | null
  /** 项目封面（最新画布里最新的图片元素）：后端 v3 新增 */
  cover_url?: string | null
  /** 项目内元素数（不含已删除元素） */
  item_count?: number
  created_at?: string | null
  updated_at?: string | null
  canvases?: Canvas[]
}

export interface CanvasState {
  elements: CanvasElement[]
  appState?: Record<string, unknown>
  files?: Record<string, unknown>
}

export interface CanvasElement {
  id: string
  type: string
  url?: string
  x?: number
  y?: number
  width?: number
  height?: number
  z?: number
  meta?: Record<string, unknown>
  [key: string]: unknown
}

export interface Canvas {
  id: string
  project_id: string
  owner_id: string
  team_id?: string | null
  visibility?: 'private' | 'team'
  version?: number
  updated_by?: string | null
  name: string
  state?: CanvasState | null
  thumbnail_url?: string | null
  share_token?: string | null
  is_public: boolean
  created_at?: string | null
  updated_at?: string | null
}

export type AssetKind = 'generated' | 'uploaded'

export interface Asset {
  id: string
  owner_id: string
  team_id?: string | null
  visibility?: 'private' | 'team'
  kind: AssetKind
  url: string
  thumb_url?: string | null
  width: number
  height: number
  size_bytes: number
  mime: string
  source_prompt: string
  is_demo: boolean
  generation_task_id?: string | null
  created_at?: string | null
}

export interface ChatSession {
  id: string
  user_id: string
  canvas_id?: string | null
  title: string
  created_at?: string | null
  updated_at?: string | null
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  session_id: string
  user_id: string
  role: ChatRole
  content: string
  attachments: unknown[]
  generation_task_id?: string | null
  created_at?: string | null
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'timeout'

export type TaskType = 'generate' | 'edit'

export interface GenerationTask {
  id: string
  user_id: string
  session_id?: string | null
  canvas_id?: string | null
  type: TaskType
  prompt: string
  params: Record<string, unknown>
  status: TaskStatus
  progress: number
  result_urls: string[]
  cost: number
  upstream_task_id?: string | null
  demo: boolean
  idempotency_key: string
  paused_at?: string | null
  timeout_at?: string | null
  last_activity_at?: string | null
  result_seen: boolean
  error_code?: string | null
  error_message?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export type TransactionType =
  | 'grant'
  | 'consume_image'
  | 'consume_edit'
  | 'consume_chat'
  | 'admin_adjust'

export interface QuotaTransaction {
  id: string
  user_id: string
  type: TransactionType
  amount: number
  status: 'processing' | 'success' | 'refunded'
  ref_id: string
  operator_id?: string | null
  balance_after: number
  note: string
  created_at?: string | null
}

export interface Prices {
  image_standard: number
  image_hd: number
  edit: number
  chat: number
}

export interface QuotaAccount {
  balance: number
  threshold_pct: number
  total_granted: number
  prices: Prices
}

export interface Announcement {
  id: string
  title: string
  content: string
  level: 'info' | 'warning'
  status: 'draft' | 'published' | 'archived'
  published_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export interface InviteCode {
  id: string
  code: string
  max_uses: number
  used_count: number
  status: 'active' | 'disabled'
  expires_at?: string | null
  created_at?: string | null
}

/** Pro 激活码（激活后解锁画布 / 抠图 / AI 对话 / 润色 / 图生图）。 */
export interface ProCode {
  id: string
  code: string
  max_uses: number
  used_count: number
  status: 'active' | 'disabled'
  note?: string
  expires_at?: string | null
  created_at?: string | null
}

export interface PoolStats {
  total: number
  normal: number
  limited: number
  abnormal: number
  disabled: number
  /** local=本地独立路由；upstream=账号在上游由它调度；none=没有可用账号 */
  routing_mode?: 'local' | 'upstream' | 'none'
  upstream_total?: number
  upstream_healthy?: number
  effective_total?: number
  effective_available?: number
}

export interface PoolAccount {
  id: string
  token_masked: string
  type: string
  status: 'normal' | 'limited' | 'abnormal' | 'disabled'
  quota: number
  last_refresh: string
}

export interface SystemConfigItem {
  key: string
  value: string
  value_type: string
  is_secret: boolean
  category: string
  description: string
  updated_at?: string | null
}

export interface Overview {
  users_total: number
  users_active: number
  pool: PoolStats
  quota_consumed_today: number
  /** 近 14 天按天聚合：新增用户 / 生成图片数 / 消耗积分 */
  series?: { date: string; users_new: number; images: number; quota: number }[]
  /** 最近动态：最多 6 条 */
  recent?: { at: string; kind: 'user' | 'quota' | 'pool' | 'audit'; text: string }[]
  /** 待处理事项 */
  pending?: {
    users_pending_verification: number
    pool_abnormal: number
    pool_limited: number
  }
}

/** 额度汇总（GET /api/quota/summary）。 */
export interface QuotaSummary {
  balance: number
  total_granted: number
  total_consumed: number
  series: { date: string; consumed: number; granted: number }[]
  by_type: { type: string; count: number; amount: number; abs_amount: number }[]
}

export interface AuditLog {
  id: string
  actor_id?: string | null
  actor_email: string
  action: string
  target_type: string
  target_id?: string | null
  detail: Record<string, unknown>
  ip: string
  created_at?: string | null
}

export interface AdminUser extends User {
  recent_transactions?: QuotaTransaction[]
}
