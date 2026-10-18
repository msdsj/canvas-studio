import { events } from '@/lib/events'
import type { Envelope, ErrorCode } from '@/types/api'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'
const TOKEN_KEY = 'cs.token'

/** 统一 API 异常。 */
export class ApiError extends Error {
  code: ErrorCode
  status: number

  constructor(code: ErrorCode, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
  headers?: Record<string, string>
}

// 相同 (method,url,body,idempotencyKey) 的 in-flight 请求共享同一个 Promise
const inflight = new Map<string, Promise<unknown>>()

/** 普通 JSON 请求的超时：弱网下 fetch 可以永久挂起，必须自己兜底。 */
const REQUEST_TIMEOUT_MS = 30_000

async function doFetch(method: string, url: string, options: RequestOptions): Promise<unknown> {
  const headers: Record<string, string> = { ...(options.headers || {}) }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  let payload: BodyInit | undefined
  const body = options.body
  if (body !== undefined) {
    if (body instanceof FormData) {
      payload = body
    } else {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
  }

  let res: Response
  // 自己的超时控制器 + 外部 signal 转发：外部主动取消仍然保持 AbortError 语义
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort)
  try {
    res = await fetch(url, { method, headers, body: payload, signal: controller.signal })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      // 用户主动取消 → 原样抛出；超时 → 给一句人话
      if (options.signal?.aborted) throw error
      throw new ApiError('UPSTREAM_ERROR', '这次等得有点久，已经帮你停下了', 0)
    }
    throw new ApiError('PROXY_UNREACHABLE', '网络好像断了，确认联网后重试', 0)
  } finally {
    window.clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }

  if (res.status === 401) {
    setToken(null)
    events.emit('auth:unauthorized')
  }

  let envelope: Envelope<unknown> | null = null
  try {
    envelope = (await res.json()) as Envelope<unknown>
  } catch {
    envelope = null
  }

  if (!envelope || typeof envelope.code !== 'string') {
    if (!res.ok) throw new ApiError('INTERNAL_ERROR', '服务开了个小差，稍等片刻再试', res.status)
    return undefined
  }
  if (envelope.code !== 'OK') {
    // Pro 专属能力被拦下：交给全局监听方弹「激活 Pro」引导，而不是各处自己处理
    if (envelope.code === 'PRO_REQUIRED') events.emit('pro:required')
    throw new ApiError(envelope.code, envelope.message || '请求失败', res.status)
  }
  return envelope.data
}

/** 发起请求并解包 `{code,data,message}`。 */
export function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method || 'GET'
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const dedupKey = `${method}:${url}:${options.idempotencyKey || ''}:${
    options.body instanceof FormData ? 'form' : JSON.stringify(options.body ?? null)
  }`
  const existing = inflight.get(dedupKey)
  if (existing) return existing as Promise<T>
  const promise = doFetch(method, url, options)
  inflight.set(dedupKey, promise)
  return promise.finally(() => {
    inflight.delete(dedupKey)
  }) as Promise<T>
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }),
  del: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE', body }),
}

/** 下载文件（用于导出/日志），返回 Blob。 */
export async function download(path: string, options: RequestOptions = {}): Promise<Blob> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = { ...(options.headers || {}) }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { method: options.method || 'GET', headers, body: options.body as BodyInit })
  if (!res.ok) throw new ApiError('INTERNAL_ERROR', '文件没能下载下来，稍后再试', res.status)
  return res.blob()
}

/** 绝对 URL（用于 <img src>）。 */
export function apiUrl(path: string): string {
  if (path.startsWith('http')) return path
  return `${BASE_URL}${path}`
}
