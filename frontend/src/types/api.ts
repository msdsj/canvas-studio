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
