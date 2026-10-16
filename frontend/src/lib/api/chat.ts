import { api } from './client'
import { getToken } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { ChatMessage, ChatSession } from '@/types/models'

export interface ChatStreamHandlers {
  onDelta: (delta: string, demo: boolean) => void
  onDone: (info: { demo: boolean; errorCode?: string }) => void
  signal?: AbortSignal
}

export const chatApi = {
  listSessions: (canvasId?: string) =>
    api.get<ChatSession[]>(`/chat/sessions${canvasId ? `?canvas_id=${canvasId}` : ''}`),
  createSession: (payload: { canvas_id?: string; title?: string }) =>
    api.post<ChatSession>('/chat/sessions', payload),
  updateSession: (id: string, title: string) =>
    api.patch<ChatSession>(`/chat/sessions/${id}`, { title }),
  deleteSession: (id: string) => api.del<unknown>(`/chat/sessions/${id}`),
  listMessages: (sessionId: string, query: PageQuery = {}) =>
    api.get<PageData<ChatMessage>>(
      `/chat/sessions/${sessionId}/messages?page=${query.page ?? 1}&size=${query.size ?? 100}`
    ),

  /** 发送消息并以 SSE 接收流式回复。返回取消函数。 */
  streamMessage: (
    payload: {
      session_id: string
      content: string
      canvas_id?: string
      image_refs?: string[]
    },
    handlers: ChatStreamHandlers
  ): (() => void) => {
    const controller = new AbortController()
    const signal = handlers.signal ?? controller.signal
    const run = async () => {
      let demo = false
      let errorCode: string | undefined
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        }
        const token = getToken()
        if (token) headers['Authorization'] = `Bearer ${token}`
        const res = await fetch(`${import.meta.env.VITE_API_BASE_URL || '/api'}/chat/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        })
        if (!res.ok || !res.body) throw new Error(`对话失败（HTTP ${res.status}）`)
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
            const dataStr = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('')
            if (dataStr) {
              try {
                const obj = JSON.parse(dataStr) as {
                  delta?: string
                  done?: boolean
                  demo?: boolean
                  error_code?: string
                }
                if (obj.demo) demo = true
                if (obj.delta) handlers.onDelta(obj.delta, demo)
                if (obj.done) {
                  errorCode = obj.error_code
                  handlers.onDone({ demo, errorCode })
                }
              } catch {
                /* ignore */
              }
            }
            index = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          handlers.onDone({ demo, errorCode: 'UPSTREAM_ERROR' })
        }
      }
    }
    void run()
    return () => controller.abort()
  },
}
