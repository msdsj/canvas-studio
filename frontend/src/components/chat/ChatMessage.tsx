import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/ui/avatar'
import { Markdown } from './Markdown'
import { Spinner } from './Spinner'
import { cn } from '@/lib/utils'
import type { ChatMessage as ChatMessageType } from '@/types/models'

interface ChatMessageProps {
  message: ChatMessageType
  streaming?: boolean
}

/** 用户气泡 / AI 文本。 */
export function ChatMessage({ message, streaming }: ChatMessageProps) {
  const { t } = useTranslation('chat')
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end gap-2">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm bg-brand-subtle px-3 py-2 text-text">
          <p className="whitespace-pre-wrap text-base">{message.content}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-2">
      <Avatar name="AI" size={28} className="mt-1 shrink-0" />
      <div className="min-w-0 flex-1">
        {message.content ? (
          <Markdown content={message.content} />
        ) : streaming ? (
          <Spinner status="running" />
        ) : null}
      </div>
    </div>
  )
}
