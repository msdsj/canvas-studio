import { useCallback, useRef, useState } from 'react'
import { chatApi } from '@/lib/api/chat'
import { useChatStore } from '@/stores/chat'

export interface SendMessageInput {
  content: string
  canvasId?: string
  imageRefs?: string[]
  idempotencyKey?: string
}

/**
 * 对话流管理：SSE 流式回复 + 进行中状态。
 * onComplete 在流结束后触发（用于刷新消息列表、刷新额度）。
 */
export function useChatStream(
  sessionId: string | null,
  onComplete?: (info: { demo: boolean; errorCode?: string }) => void
) {
  const [sending, setSending] = useState(false)
  const streamingText = useChatStore((s) => (sessionId ? s.streaming[sessionId] ?? '' : ''))
  const setStreaming = useChatStore((s) => s.setStreaming)
  const appendStreaming = useChatStore((s) => s.appendStreaming)
  const clearStreaming = useChatStore((s) => s.clearStreaming)

  const cancelRef = useRef<null | (() => void)>(null)

  const send = useCallback(
    (input: SendMessageInput) => {
      if (!sessionId || !input.content.trim()) return
      setSending(true)
      setStreaming(sessionId, '')
      const cancel = chatApi.streamMessage(
        {
          session_id: sessionId,
          content: input.content,
          canvas_id: input.canvasId,
          image_refs: input.imageRefs,
        },
        {
          onDelta: (delta) => appendStreaming(sessionId, delta),
          onDone: (info) => {
            setSending(false)
            clearStreaming(sessionId)
            onComplete?.(info)
          },
        }
      )
      cancelRef.current = cancel
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, setStreaming, appendStreaming, clearStreaming, onComplete]
  )

  const stop = useCallback(() => {
    cancelRef.current?.()
    if (sessionId) clearStreaming(sessionId)
    setSending(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, clearStreaming])

  return { sending, streamingText, send, stop }
}
