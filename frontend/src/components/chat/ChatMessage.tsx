import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Markdown } from './Markdown'
import { parseServerTime } from '@/lib/utils'
import type { MessageImageAttachment } from '@/lib/api/chat'
import type { ChatMessage as ChatMessageType } from '@/types/models'

interface ChatMessageProps {
  message: ChatMessageType
  streaming?: boolean
  /** 用户消息附带的参考图（上传 / 粘贴） */
  images?: MessageImageAttachment[]
}

function formatTime(value?: string | null): string {
  if (!value) return ''
  const date = parseServerTime(value)
  if (!date) return ''
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`
}

/**
 * 标准聊天气泡：用户消息 / AI 回复。
 *
 * 两类消息靠三重差异区分，避免看混：
 * - 对齐方向：用户靠右、AI 靠左（AI 侧带头像）；
 * - 背景：用户青柠底（accent-soft）、AI 纸面白底；
 * - 边框：用户青柠描边、AI 淡描边 + 卡片投影。
 *
 * 内容一律完整展开，不做任何折叠/收起；中间处理信息（提示词、思考步骤）
 * 不在这里出现。
 */
function ChatMessageInner({ message, streaming, images }: ChatMessageProps) {
  const { t } = useTranslation('chat')
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)

  const time = useMemo(() => formatTime(message.created_at), [message.created_at])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  if (isUser) {
    const shots = images ?? []
    return (
      <div className="cs-bubble-in-right flex flex-col items-end gap-1">
        <div className="flex items-center gap-1.5 pr-1">
          <span className="text-micro text-text-tertiary">{t('message.you')}</span>
          {time && <span className="text-micro text-text-tertiary">{time}</span>}
          {message.content && (
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={t('message.copy', { defaultValue: '复制' })}
              title={t('message.copy', { defaultValue: '复制' })}
              className="flex h-5 w-5 items-center justify-center rounded-xs text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
            >
              {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            </button>
          )}
        </div>
        {shots.length > 0 && (
          <div className="flex max-w-[92%] flex-wrap justify-end gap-1">
            {shots.slice(0, 3).map((image) => (
              <img
                key={image.asset_id}
                src={image.url}
                alt={image.name || '参考图'}
                className="h-16 w-16 rounded-xs object-cover shadow-sheet"
              />
            ))}
            {shots.length > 3 && (
              <span className="flex h-16 w-10 items-center justify-center rounded-xs bg-bg-subtle text-micro text-text-tertiary">
                +{shots.length - 3}
              </span>
            )}
          </div>
        )}
        <div className="max-w-[92%] rounded-lg rounded-br-xs bg-accent-soft px-3.5 py-2.5 text-text ring-1 ring-inset ring-accent-strong/35">
          <p className="whitespace-pre-wrap text-body leading-[1.7] [overflow-wrap:anywhere]">
            {message.content}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="cs-bubble-in-left group flex gap-2.5">
      <Avatar name="AI" size={24} className="mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-micro text-text-tertiary">{t('message.assistant')}</span>
          {time && <span className="text-micro text-text-tertiary">{time}</span>}
          {message.content && (
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={t('message.copy', { defaultValue: '复制' })}
              title={t('message.copy', { defaultValue: '复制' })}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-xs text-text-tertiary opacity-0 transition-opacity hover:bg-surface-hover focus-visible:opacity-100 group-hover:opacity-100"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
        </div>
        {message.content ? (
          <div className="min-w-0 rounded-lg rounded-bl-xs bg-surface px-3.5 py-3 shadow-sheet ring-1 ring-inset ring-border-faint">
            <Markdown content={message.content} />
            {/* 流式光标：让"还在写"这件事有明确的视觉信号 */}
            {streaming && (
              <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse rounded-full bg-brand align-[-0.15em]" />
            )}
          </div>
        ) : streaming ? (
          <div className="inline-flex items-center gap-1 rounded-lg rounded-bl-xs bg-surface px-3.5 py-3 shadow-sheet ring-1 ring-inset ring-border-faint">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary"
                style={{ animationDelay: `${index * 120}ms`, animationDuration: '900ms' }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 轮询每 2.5s 会换掉 tasks 数组引用 → 时间线整体重算。
 * memo 之后消息气泡不会跟着重渲染，长对话滚动才不卡。
 *
 * 参考图数组每次渲染都是新引用，直接浅比较会让 memo 失效，所以只比长度与首图。
 */
export const ChatMessage = memo(
  ChatMessageInner,
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.streaming === next.streaming &&
    (prev.images?.length ?? 0) === (next.images?.length ?? 0) &&
    (prev.images?.[0]?.asset_id ?? '') === (next.images?.[0]?.asset_id ?? '')
)
