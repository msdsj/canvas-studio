import { getToken } from '@/lib/api/client'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

export interface SSEOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  idempotencyKey?: string
  signal?: AbortSignal
  /** 每收到一个 data 块触发（已 JSON.parse） */
  onMessage: (data: Record<string, unknown>) => void
  onError?: (error: unknown) => void
  onDone?: () => void
  /** 断线自动重连（指数退避） */
  reconnect?: boolean
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

async function streamOnce(path: string, options: SSEOptions, signal: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

  let payload: BodyInit | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: payload,
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`SSE 连接失败（HTTP ${res.status}）`)
  }

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
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
      const dataStr = dataLines.join('\n')
      if (dataStr && dataStr !== '[DONE]') {
        try {
          options.onMessage(JSON.parse(dataStr) as Record<string, unknown>)
        } catch {
          /* 忽略非法 JSON 块 */
        }
      }
      index = buffer.indexOf('\n\n')
    }
  }
}

/**
 * 打开一个 SSE 连接；返回取消函数。
 * 支持断线指数退避重连（P0-35 网络恢复自动续接）。
 */
export function openSSE(path: string, options: SSEOptions): () => void {
  const controller = new AbortController()
  const signal = options.signal ?? controller.signal
  const maxRetries = options.maxRetries ?? 5
  const baseDelay = options.baseDelayMs ?? 1000
  const maxDelay = options.maxDelayMs ?? 10000

  const run = async () => {
    let attempt = 0
    // 首次连接不重试；仅当 reconnect=true 且非用户取消时退避重试
    while (true) {
      try {
        await streamOnce(path, options, signal)
        options.onDone?.()
        return
      } catch (error) {
        if ((error as Error).name === 'AbortError' || signal.aborted) return
        options.onError?.(error)
        if (!options.reconnect) return
        if (attempt >= maxRetries) return
        attempt += 1
        const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay)
        try {
          await sleep(delay, signal)
        } catch {
          return
        }
      }
    }
  }

  void run()
  return () => controller.abort()
}
