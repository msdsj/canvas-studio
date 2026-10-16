import { ApiError } from '@/lib/api/client'
import type { ErrorCode } from '@/types/api'

// 错误码 → i18n key（errors 命名空间）
export const ERROR_I18N_KEY: Record<ErrorCode, string> = {
  OK: 'errors.ok',
  QUOTA_INSUFFICIENT: 'errors.quota_insufficient',
  UNAUTHORIZED: 'errors.unauthorized',
  FORBIDDEN: 'errors.forbidden',
  UPSTREAM_ERROR: 'errors.upstream_error',
  POOL_UNAVAILABLE: 'errors.pool_unavailable',
  PROXY_UNREACHABLE: 'errors.proxy_unreachable',
  TASK_NOT_FOUND: 'errors.task_not_found',
  TASK_STATE_CONFLICT: 'errors.task_state_conflict',
  TASK_LIMIT_EXCEEDED: 'errors.task_limit_exceeded',
  RATE_LIMITED: 'errors.rate_limited',
  VALIDATION_ERROR: 'errors.validation_error',
  NOT_FOUND: 'errors.not_found',
  INTERNAL_ERROR: 'errors.internal_error',
}

export interface Translate {
  (key: string, options?: Record<string, unknown>): string
}

/** 把任意错误翻译为可展示文案。 */
export function errorMessage(error: unknown, t?: Translate): string {
  if (error instanceof ApiError) {
    if (t) {
      const key = ERROR_I18N_KEY[error.code]
      if (key) {
        const translated = t(key, { defaultValue: error.message })
        if (translated) return translated
      }
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

export { ApiError }
