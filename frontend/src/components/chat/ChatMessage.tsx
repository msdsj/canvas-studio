import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Markdown } from './Markdown'
import { cn, parseServerTime } from '@/lib/utils'
import type { MessageImageAttachment } from '@/lib/api/chat'
import type { ChatMessage as ChatMessageType } from '@/types/models'

interface ChatMessageProps {
  message: ChatMessageType
  streaming?: boolean
  /** 用户消息附带的参考图（上传 / 粘贴） */
  images?: MessageImageAttachment[]
}

/** 长消息折叠阈值（字符数）。 */
const COLLAPSE_AT = 180

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
 * 用户气泡 / AI 文本。
 *
 * 排版原则（窄栏里尤其重要）：
 * - 用户消息给到 92% 宽度，长句不被迫拆成每行两三个字；
 * - 长英文/URL 用 `overflow-wrap:anywhere` 兜底，绝不撑破气泡；
 * - AI 文本占满剩余宽度，Markdown 里的代码块自己横向滚动。
 */
function ChatMessageInner({ message, streaming, images }: ChatMessageProps) {
  const { t } = useTranslation('chat')
  const isUser = message.role === 'user'
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const time = useMemo(() => formatTime(message.created_at), [message.created_at])
  const collapsible = !isUser && message.content.length > COLLAPSE_AT

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
        <span className="pr-1 text-micro text-text-tertiary">{t('message.you')}</span>
        {shots.length > 0 && (
          <div className="flex max-w-[92%] flex-wrap justify-end gap-1">
            {shots.slice(0, 3).map((image) => (
              <img
                key={image.asset_id}
                src={image.url}
                alt={image.name || '参考图'}
                className="h-16 w-16 rounded-[10px] border border-border object-cover"
              />
            ))}
            {shots.length > 3 && (
              <span className="flex h-16 w-10 items-center justify-center rounded-[10px] bg-bg-subtle text-micro text-text-tertiary">
                +{shots.length - 3}
              </span>
            )}
          </div>
        )}
        <div className="max-w-[92%] rounded-[16px] rounded-br-[6px] bg-bg-subtle px-3.5 py-2.5 text-text">
          <p className="whitespace-pre-wrap text-body leading-[1.7] [overflow-wrap:anywhere]">
            {message.content}
          </p>
        </div>
        {time && <span className="pr-1 text-micro text-text-tertiary">{time}</span>}
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
              aria-label={t('task.copy_prompt')}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded-[6px] text-text-tertiary opacity-0 transition-opacity hover:bg-surface-hover focus-visible:opacity-100 group-hover:opacity-100"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
        </div>
        {message.content ? (
          <div className={cn('min-w-0', collapsible && !expanded && 'line-clamp-3')}>
            <Markdown content={message.content} />
            {/* 流式光标：让"还在写"这件事有明确的视觉信号 */}
            {streaming && (
              <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse rounded-full bg-brand align-[-0.15em]" />
            )}
          </div>
        ) : streaming ? (
          <div className="flex items-center gap-1 py-1.5">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary"
                style={{ animationDelay: `${index * 120}ms`, animationDuration: '900ms' }}
              />
            ))}
          </div>
        ) : null}
        {collapsible && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-1 text-caption text-brand-text hover:underline"
          >
            {expanded ? t('message.collapse') : t('message.expand')}
          </button>
        )}
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
