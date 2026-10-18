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
}

export interface CanvasProject {
  id: string
  owner_id: string
  name: string
  description: string
  thumbnail_url?: string | null
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
