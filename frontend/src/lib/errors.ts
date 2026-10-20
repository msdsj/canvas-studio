import i18n from '@/i18n'
import { ApiError } from '@/lib/api/client'
import type { ErrorCode } from '@/types/api'

/**
 * 错误码 → `errors` 命名空间下的裸 key（不带 `errors.` 前缀）。
 *
 * 注意：这里必须是裸 key。i18next 的 `nsSeparator` 默认是 `:` 而不是 `.`，
 * 写成 `errors.upstream_error` 会被当成 common 命名空间下的嵌套路径，永远查不到，
 * 于是每次都会回落到后端 `message` 原文（历史 bug 的根因）。
 */
export const ERROR_I18N_KEY: Record<ErrorCode, string> = {
  OK: 'ok',
  QUOTA_INSUFFICIENT: 'quota_insufficient',
  PRO_REQUIRED: 'pro_required',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  UPSTREAM_ERROR: 'upstream_error',
  POOL_UNAVAILABLE: 'pool_unavailable',
  PROXY_UNREACHABLE: 'proxy_unreachable',
  TASK_NOT_FOUND: 'task_not_found',
  TASK_STATE_CONFLICT: 'task_state_conflict',
  TASK_LIMIT_EXCEEDED: 'task_limit_exceeded',
  RATE_LIMITED: 'rate_limited',
  VALIDATION_ERROR: 'validation_error',
  NOT_FOUND: 'not_found',
  INTERNAL_ERROR: 'internal_error',
  MODEL_CONFIG_FORBIDDEN: 'model_config_forbidden',
  SEAT_LIMIT_EXCEEDED: 'seat_limit_exceeded',
  CANVAS_VERSION_CONFLICT: 'canvas_version_conflict',
}

export interface Translate {
  (key: string, options?: Record<string, unknown>): string
}

/** 统一兜底文案：任何查不到映射的错误都用这一句，绝不回落到后端原文。 */
export const FALLBACK_ERROR_TEXT = '出了点小状况，重试一次；还不行请联系客服'

/** 按错误码取用户文案（找不到映射则返回兜底）。 */
export function errorTextByCode(code?: string | null, t?: Translate): string {
  const key = code ? ERROR_I18N_KEY[code as ErrorCode] : undefined
  const translate: Translate = t ?? ((k, o) => i18n.t(k, o) as string)
  if (key) {
    const text = translate(`errors.${key}`, { ns: 'errors', defaultValue: '' })
    // 查不到时 i18next 会把 key 本身返回，这里一并拦掉
    if (text && !text.startsWith('errors.')) return text
  }
  return translate('errors.unknown', { ns: 'errors', defaultValue: FALLBACK_ERROR_TEXT })
}

/**
 * 把任意错误翻译为用户可读文案。
 *
 * 铁律：后端 `message` 一律不上屏——它可能包含上游原始报文、内网地址、异常堆栈。
 * 只允许「错误码 → 固定文案」这一条路径，查不到就走兜底。
 */
export function errorMessage(error: unknown, t?: Translate): string {
  if (error instanceof ApiError) return errorTextByCode(error.code, t)
  // 前端自身异常（网络中断、解析失败等）一律按网络类文案处理，不透传 message
  if (error instanceof Error) return errorTextByCode('PROXY_UNREACHABLE', t)
  return errorTextByCode(undefined, t)
}

export { ApiError }
