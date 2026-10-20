// 请求 / 响应 / 错误码类型

export type ErrorCode =
  | 'OK'
  | 'QUOTA_INSUFFICIENT'
  | 'PRO_REQUIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'UPSTREAM_ERROR'
  | 'POOL_UNAVAILABLE'
  | 'PROXY_UNREACHABLE'
  | 'TASK_NOT_FOUND'
  | 'TASK_STATE_CONFLICT'
  | 'TASK_LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  /** 团队接管模型配置后，成员不再拥有个人模型设置入口 */
  | 'MODEL_CONFIG_FORBIDDEN'
  /** 团队席位数已满 */
  | 'SEAT_LIMIT_EXCEEDED'
  /** 画布版本落后太多，需要全量重同步 */
  | 'CANVAS_VERSION_CONFLICT'

export interface Envelope<T> {
  code: ErrorCode
  data: T
  message: string
}

export interface PageData<T> {
  items: T[]
  total: number
  page: number
  size: number
}

export interface ApiErrorShape {
  code: ErrorCode
  message: string
  status: number
}

export interface PageQuery {
  page?: number
  size?: number
}

export interface IdempotentOptions {
  idempotencyKey?: string
}
