import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collabApi, type CanvasPatch, type CollabParticipant } from '@/lib/api/collab'

/** 协作连接状态。`offline` 表示降级为「整场景自动保存」，功能不中断。 */
export type CollabStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline'

export interface RemotePatch {
  version: number
  patch: CanvasPatch
  /** 谁改的（用于「张三正在编辑」的提示与本地回放抑制） */
  userId: string
}

interface UseCanvasCollabOptions {
  canvasId: string | null
  /** 是否启用协作。非团队画布不连（省一个常驻 WS） */
  enabled: boolean
  /** 收到远端 patch（增量） */
  onPatch: (patch: CanvasPatch, version: number) => void
  /** 需要全量重同步（版本落后太多 / 服务端重启） */
  onResync: () => void
}

interface UseCanvasCollabResult {
  status: CollabStatus
  participants: CollabParticipant[]
  canWrite: boolean
  version: number
  /** 发一批本地改动。返回 false 表示没连上（调用方应回退到整场景保存） */
  sendPatch: (patch: CanvasPatch) => boolean
  /** 更新光标/选区（节流交给调用方） */
  sendPresence: (
    cursor: { x: number; y: number } | null,
    selection?: string[],
    viewport?: { zoom: number; scrollX: number; scrollY: number }
  ) => void
  /** 主动请求全量重同步 */
  requestResync: () => void
}

/** 重连退避（毫秒）：1s → 2s → 4s → 8s，封顶 15s，避免断网时疯狂重连。 */
const BACKOFF = [1000, 2000, 4000, 8000, 15000]
/** 心跳间隔：服务端 90 秒没消息会踢，这里 25 秒发一次足够。 */
const HEARTBEAT_MS = 25_000

/**
 * 画布实时协作。
 *
 * 为什么用票据而不是 token：浏览器的 WebSocket API 不能带自定义请求头，
 * 把 access token 塞进 query string 会进浏览器历史、代理日志和 Referer。
 * 所以先用 HTTP 换一张 30 秒有效、绑定单画布的短票据，再拿它连 WS。
 *
 * 断线策略：指数退避自动重连；重连成功后请求全量快照（比「猜自己漏了哪些」稳）。
 * 如果连不上（比如部署在只支持 HTTP 的环境），状态落到 `offline`，
 * 调用方继续走原来的整场景自动保存——**协作不可用不该让画布变得不能用**。
 */
export function useCanvasCollab({
  canvasId,
  enabled,
  onPatch,
  onResync,
}: UseCanvasCollabOptions): UseCanvasCollabResult {
  const [status, setStatus] = useState<CollabStatus>('idle')
  const [participants, setParticipants] = useState<CollabParticipant[]>([])
  const [canWrite, setCanWrite] = useState(true)
  const [version, setVersion] = useState(0)

  const socketRef = useRef<WebSocket | null>(null)
  const versionRef = useRef(0)
  const attemptRef = useRef(0)
  const timerRef = useRef<number | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  /** 组件卸载后不再重连（否则会在后台无限重试） */
  const disposedRef = useRef(false)

  // 回调放进 ref：避免父组件每次重渲染都触发重连
  const onPatchRef = useRef(onPatch)
  const onResyncRef = useRef(onResync)
  onPatchRef.current = onPatch
  onResyncRef.current = onResync

  const clearTimers = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (heartbeatRef.current !== null) {
      window.clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }, [])

  const connect = useCallback(async () => {
    if (!canvasId || disposedRef.current) return
    setStatus((prev) => (prev === 'online' ? prev : attemptRef.current === 0 ? 'connecting' : 'reconnecting'))

    let ticket: Awaited<ReturnType<typeof collabApi.ticket>>
    try {
      ticket = await collabApi.ticket(canvasId)
    } catch {
      // 拿不到票据（无权限/后端没开）：直接降级，不再重试
      setStatus('offline')
      return
    }
    if (disposedRef.current) return

    setCanWrite(ticket.can_write)
    versionRef.current = ticket.version
    setVersion(ticket.version)

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    // 走同源 + Vite/nginx 的 /api 代理，避免额外开一个 WS 端口
    const sinceParam = attemptRef.current > 0 ? `&since=${versionRef.current}` : ''
    const url = `${scheme}://${window.location.host}/api/collab/ws/${canvasId}?ticket=${encodeURIComponent(ticket.ticket)}${sinceParam}`

    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      setStatus('offline')
      return
    }
    socketRef.current = ws

    ws.onopen = () => {
      attemptRef.current = 0
      setStatus('online')
      heartbeatRef.current = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, HEARTBEAT_MS)
    }

    ws.onmessage = (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(event.data as string) as Record<string, unknown>
      } catch {
        return
      }
      const type = String(message.type ?? '')

      if (type === 'snapshot') {
        versionRef.current = Number(message.version ?? 0)
        setVersion(versionRef.current)
        setParticipants((message.participants as CollabParticipant[]) ?? [])
        // 快照意味着本地状态可能过期：交给上层用 snapshot 的 state 覆盖
        onResyncRef.current()
        return
      }

      if (type === 'replay') {
        /*
         * 断线重连的增量补齐：只补断线期间漏掉的 patch，不重传整份场景。
         * 必须逐条 apply —— 合并是按版本的 LWW，跳着应用会算出错误结果。
         */
        const patches = (message.patches as Array<{ version: number; patch: CanvasPatch }>) ?? []
        for (const entry of patches) {
          if (entry?.patch) onPatchRef.current(entry.patch, entry.version)
        }
        versionRef.current = Number(message.version ?? versionRef.current)
        setVersion(versionRef.current)
        setParticipants((message.participants as CollabParticipant[]) ?? [])
        return
      }

      if (type === 'patch') {
        const next = Number(message.version ?? 0)
        versionRef.current = next
        setVersion(next)
        onPatchRef.current(
          (message.patch as CanvasPatch) ?? {},
          next,
        )
        return
      }

      if (type === 'full_state') {
        versionRef.current = Number(message.version ?? 0)
        setVersion(versionRef.current)
        onResyncRef.current()
        return
      }

      if (type === 'presence' || type === 'peer_joined' || type === 'peer_left') {
        setParticipants((message.participants as CollabParticipant[]) ?? [])
        return
      }

      if (type === 'error') {
        // 版本冲突：让上层全量重同步，而不是把用户这次改动丢掉
        if (message.resync === true) {
          onResyncRef.current()
        }
      }
    }

    ws.onclose = (event) => {
      clearTimers()
      socketRef.current = null
      if (disposedRef.current) return
      // 4401/4403/4429 是「没权限/票据失效/房间满」：重连也没用，直接降级
      if (event.code === 4401 || event.code === 4403 || event.code === 4429) {
        setStatus('offline')
        return
      }
      const delay = BACKOFF[Math.min(attemptRef.current, BACKOFF.length - 1)]
      attemptRef.current += 1
      setStatus('reconnecting')
      timerRef.current = window.setTimeout(() => void connect(), delay)
    }

    ws.onerror = () => {
      // onerror 之后一定会有 onclose，重连逻辑统一放那儿
    }
  }, [canvasId, clearTimers])

  useEffect(() => {
    if (!enabled || !canvasId) {
      setStatus('idle')
      return
    }
    disposedRef.current = false
    attemptRef.current = 0
    void connect()
    return () => {
      disposedRef.current = true
      clearTimers()
      const ws = socketRef.current
      socketRef.current = null
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
      setStatus('idle')
      setParticipants([])
    }
  }, [enabled, canvasId, connect, clearTimers])

  const sendPatch = useCallback((patch: CanvasPatch) => {
    const ws = socketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    ws.send(
      JSON.stringify({
        type: 'patch',
        base_version: versionRef.current,
        patch,
      }),
    )
    return true
  }, [])

  const sendPresence = useCallback(
    (
      cursor: { x: number; y: number } | null,
      selection?: string[],
      viewport?: { zoom: number; scrollX: number; scrollY: number }
    ) => {
      const ws = socketRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'presence', cursor, selection, viewport }))
    },
    [],
  )

  const requestResync = useCallback(() => {
    const ws = socketRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'resync' }))
  }, [])

  // 同样要 memo：这个对象会被上层放进 useCallback 依赖，每次新对象会让整条
  // onChange → pushLocal 链路每帧重建
  return useMemo(
    () => ({ status, participants, canWrite, version, sendPatch, sendPresence, requestResync }),
    [status, participants, canWrite, version, sendPatch, sendPresence, requestResync],
  )
}
