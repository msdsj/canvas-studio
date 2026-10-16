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
  try {
    res = await fetch(url, { method, headers, body: payload, signal: options.signal })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new ApiError('PROXY_UNREACHABLE', '网络不可达，请检查连接后重试', 0)
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
    if (!res.ok) throw new ApiError('INTERNAL_ERROR', `请求失败（HTTP ${res.status}）`, res.status)
    return undefined
  }
  if (envelope.code !== 'OK') {
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
  if (!res.ok) throw new ApiError('INTERNAL_ERROR', `下载失败（HTTP ${res.status}）`, res.status)
  return res.blob()
}

/** 绝对 URL（用于 <img src>）。 */
export function apiUrl(path: string): string {
  if (path.startsWith('http')) return path
  return `${BASE_URL}${path}`
}
