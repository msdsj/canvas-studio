import { memo, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Markdown } from './Markdown'
import { AgentGlyph } from './agent/AgentGlyph'
import { AgentTrace, type TraceStep } from './agent/AgentTrace'
import { SkillChip } from './agent/SkillChip'
import { cn, parseServerTime } from '@/lib/utils'
import type { MessageImageAttachment } from '@/lib/api/chat'
import type { ChatMessage as ChatMessageType } from '@/types/models'

interface ChatMessageProps {
  message: ChatMessageType
  streaming?: boolean
  /** 用户消息附带的参考图（上传 / 粘贴） */
  images?: MessageImageAttachment[]
  /** AI 回复背后的分析轨迹（compose_run / skill_run 的 steps），默认折叠 */
  traceSteps?: TraceStep[]
  /** 轨迹默认展开（最新一轮回复：分析过程与回答同屏） */
  traceOpen?: boolean
  /** 本次套用的设计技能 */
  skillId?: string | null
  skillName?: string | null
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

/** 消息下方的小操作按钮（复制 / 赞 / 踩）。 */
function ActionButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-xs transition-colors',
        active ? 'bg-accent-soft text-accent-ink' : 'text-text-tertiary hover:bg-surface-hover hover:text-text'
      )}
    >
      {children}
    </button>
  )
}

/**
 * 标准聊天消息：用户消息 / Agent 回复。
 *
 * - 用户：靠右的浅底气泡，参考图在气泡上方；
 * - Agent：不套重卡片，正文直接排在面板上（像 Lovart 的回复），
 *   上方可折叠的分析轨迹 + 技能标签，下方复制 / 赞 / 踩。
 *
 * 中间处理信息（最终提示词）不在这里出现。
 */
function ChatMessageInner({ message, streaming, images, traceSteps, traceOpen, skillId, skillName }: ChatMessageProps) {
  const { t } = useTranslation('chat')
  const { t: ta } = useTranslation('agent')
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)

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
      <div className="cs-bubble-in-right group flex flex-col items-end gap-1.5">
        {/* 头部：时间 · 你（右对齐），与 Agent 侧的「名字 · 时间」镜像 */}
        <div className="flex items-center gap-1.5 pr-0.5">
          {message.content && (
            <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <ActionButton
                label={copied ? ta('feedback.copied') : ta('feedback.copy')}
                onClick={() => void copy()}
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </ActionButton>
            </span>
          )}
          {time && <span className="text-micro tabular-nums text-text-faint">{time}</span>}
          <span className="text-micro font-medium text-text-tertiary">{t('message.you')}</span>
        </div>
        {shots.length > 0 && (
          <div className="flex max-w-[88%] flex-wrap justify-end gap-1.5">
            {shots.slice(0, 3).map((image) => (
              <img
                key={image.asset_id}
                src={image.url}
                alt={image.name || t('input.reference')}
                className="h-16 w-16 rounded-sm object-cover shadow-sheet ring-1 ring-inset ring-border-faint"
              />
            ))}
            {shots.length > 3 && (
              <span className="flex h-16 w-10 items-center justify-center rounded-sm bg-bg-subtle text-micro text-text-tertiary">
                +{shots.length - 3}
              </span>
            )}
          </div>
        )}
        {message.content && (
          // 墨色实底：用户自己的话要一眼和 Agent 的回答分开（对标 zleap 软件开发的对话）
          <div className="max-w-[86%] rounded-[16px] rounded-tr-[6px] bg-brand px-3.5 py-2 text-text-inverse shadow-sheet">
            <p className="whitespace-pre-wrap text-ui leading-[1.65] [overflow-wrap:anywhere]">
              {message.content}
            </p>
          </div>
        )}
      </div>
    )
  }

  const hasTrace = (traceSteps?.length ?? 0) > 0

  return (
    <div className="cs-bubble-in-left group flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <AgentGlyph size={22} active={streaming} />
        <span className="text-caption font-semibold text-text">{ta('name')}</span>
        {time && <span className="text-micro tabular-nums text-text-faint">{time}</span>}
      </div>

      <div className="min-w-0 pl-[30px]">
        {hasTrace ? (
          <AgentTrace
            steps={traceSteps ?? []}
            defaultOpen={traceOpen}
            skillId={skillId}
            skillName={skillName}
            className="mb-2"
          />
        ) : (
          (skillId || skillName) && (
            <SkillChip skillId={skillId} name={skillName} className="mb-2" />
          )
        )}

        {message.content ? (
          // 回答放进一张浅描边卡片：长回复（列表 / 参数）有边界才好读，
          // 和下方的决策卡、结果卡在视觉上属于同一组
          <div className="min-w-0 rounded-[16px] rounded-tl-[6px] bg-surface px-3.5 py-2.5 shadow-xs ring-1 ring-inset ring-border-faint">
            <Markdown content={message.content} size="ui" />
            {/* 流式光标：让"还在写"这件事有明确的视觉信号 */}
            {streaming && (
              <span className="cs-caret ml-0.5 inline-block h-[1em] w-[2px] rounded-full bg-accent-strong align-[-0.15em]" />
            )}
          </div>
        ) : streaming ? (
          <div className="inline-flex items-center gap-1 rounded-[16px] rounded-tl-[6px] bg-surface px-3.5 py-3 ring-1 ring-inset ring-border-faint">
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-tertiary"
                style={{ animationDelay: `${index * 120}ms`, animationDuration: '900ms' }}
              />
            ))}
          </div>
        ) : null}

        {message.content && !streaming && (
          <div className="mt-1 flex items-center gap-0.5 text-text-tertiary opacity-70 transition-opacity group-hover:opacity-100">
            <ActionButton label={copied ? ta('feedback.copied') : ta('feedback.copy')} onClick={() => void copy()}>
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            </ActionButton>
            <ActionButton
              label={ta('feedback.like')}
              active={vote === 'up'}
              onClick={() => setVote((v) => (v === 'up' ? null : 'up'))}
            >
              <ThumbsUp size={13} />
            </ActionButton>
            <ActionButton
              label={ta('feedback.dislike')}
              active={vote === 'down'}
              onClick={() => setVote((v) => (v === 'down' ? null : 'down'))}
            >
              <ThumbsDown size={13} />
            </ActionButton>
            {vote && <span className="ml-1 text-micro text-text-faint cs-in">{ta('feedback.thanks')}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 轮询每 2.5s 会换掉 tasks 数组引用 → 时间线整体重算。
 * memo 之后消息气泡不会跟着重渲染，长对话滚动才不卡。
 *
 * 参考图 / 轨迹数组每次渲染都可能是新引用，直接浅比较会让 memo 失效，
 * 所以只比长度与关键标识。
 */
export const ChatMessage = memo(
  ChatMessageInner,
  (prev, next) =>
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.streaming === next.streaming &&
    prev.traceOpen === next.traceOpen &&
    (prev.images?.length ?? 0) === (next.images?.length ?? 0) &&
    (prev.images?.[0]?.asset_id ?? '') === (next.images?.[0]?.asset_id ?? '') &&
    JSON.stringify(prev.traceSteps ?? []) === JSON.stringify(next.traceSteps ?? []) &&
    (prev.skillId ?? '') === (next.skillId ?? '') &&
    (prev.skillName ?? '') === (next.skillName ?? '')
)
