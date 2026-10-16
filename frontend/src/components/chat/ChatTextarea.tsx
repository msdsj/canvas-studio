import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Send, Square, Paperclip, Sparkles, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ChatMode = 'chat' | 'image'

interface ChatTextareaProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop?: () => void
  sending?: boolean
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  disabled?: boolean
  disabledReason?: string
  onAttach?: () => void
  /** 外部信号（递增触发聚焦输入框，例如画布框选完成后引导输入指令） */
  focusSignal?: number
}

/** 对话输入框（含模式切换 / 快捷键 / 额度拦截禁用）。 */
export function ChatTextarea({
  value,
  onChange,
  onSend,
  onStop,
  sending,
  mode,
  onModeChange,
  disabled,
  onAttach,
  focusSignal,
}: ChatTextareaProps) {
  const { t } = useTranslation('chat')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focusSignal) ref.current?.focus()
  }, [focusSignal])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!disabled && value.trim()) onSend()
    }
  }

  return (
    <div className="border-t border-border p-3">
      <div className="mb-2 flex items-center gap-1">
        <ModeChip active={mode === 'chat'} onClick={() => onModeChange('chat')} icon={<MessageSquare size={13} />}>
          {t('mode.chat')}
        </ModeChip>
        <ModeChip active={mode === 'image'} onClick={() => onModeChange('image')} icon={<Sparkles size={13} />}>
          {t('mode.image')}
        </ModeChip>
      </div>
      <div className="flex items-end gap-2 rounded-md border border-border-strong bg-surface px-2 py-1.5 focus-within:border-brand">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('input.placeholder')}
          rows={3}
          className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent text-base text-text placeholder:text-text-tertiary focus:outline-none"
        />
        <div className="flex items-center gap-1 pb-0.5">
          {onAttach && (
            <Button variant="ghost" size="icon-sm" aria-label={t('input.attach')} onClick={onAttach}>
              <Paperclip size={16} />
            </Button>
          )}
          {sending ? (
            <Button variant="secondary" size="icon-sm" aria-label={t('input.stop')} onClick={onStop}>
              <Square size={15} />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label={t('input.send')}
              disabled={disabled || !value.trim()}
              onClick={onSend}
            >
              <Send size={15} />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function ModeChip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs transition-colors',
        active ? 'bg-brand-subtle text-brand-text' : 'text-text-tertiary hover:bg-surface-hover'
      )}
    >
      {icon}
      {children}
    </button>
  )
}
