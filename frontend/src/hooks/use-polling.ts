import { useEffect, useRef, useState } from 'react'

export interface PollingOptions {
  /** 是否启用 */
  enabled?: boolean
  /** 基础间隔（ms） */
  intervalMs?: number
  /** 退避上限（ms） */
  maxIntervalMs?: number
  /** 是否启用指数退避（连续无变化时拉长间隔） */
  backoff?: boolean
}

/**
 * 自适应退避轮询：用于任务进度、号池刷新等（P0-35 断线退避）。
 * fetcher 返回的对象若带有变化，会重置为基线间隔。
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  options: PollingOptions = {}
): { data: T | null; loading: boolean; refresh: () => Promise<void> } {
  const { enabled = true, intervalMs = 1500, maxIntervalMs = 10000, backoff = true } = options
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const intervalRef = useRef(intervalMs)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stoppedRef = useRef(false)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const lastSerialized = useRef<string>('')

  useEffect(() => {
    stoppedRef.current = false
    if (!enabled) return
    const tick = async () => {
      if (stoppedRef.current) return
      try {
        setLoading(true)
        const result = await fetcherRef.current()
        setData(result)
        const serialized = JSON.stringify(result)
        if (backoff && serialized === lastSerialized.current) {
          intervalRef.current = Math.min(intervalRef.current * 2, maxIntervalMs)
        } else {
          intervalRef.current = intervalMs
        }
        lastSerialized.current = serialized
      } catch {
        // 网络异常：退避
        if (backoff) intervalRef.current = Math.min(intervalRef.current * 2, maxIntervalMs)
      } finally {
        setLoading(false)
        if (!stoppedRef.current) {
          timerRef.current = setTimeout(tick, intervalRef.current)
        }
      }
    }
    void tick()
    return () => {
      stoppedRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, maxIntervalMs, backoff])

  const refresh = async () => {
    try {
      const result = await fetcherRef.current()
      setData(result)
      intervalRef.current = intervalMs
    } catch {
      /* ignore */
    }
  }

  return { data, loading, refresh }
}
