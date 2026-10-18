import { useEffect, useRef, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon, Loader2, Paperclip, Send, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 提示词上限：与后端 `schemas/generate.py` 的 max_length 保持一致。 */
export const PROMPT_MAX_LENGTH = 4000
/** 超过这个长度开始显示字数，避免平时干扰。 */
const COUNTER_VISIBLE_FROM = 3600

export interface ComposerAttachment {
  id: string
  url: string
  name?: string
}

interface ChatTextareaProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop?: () => void
  sending?: boolean
  /** 请求已发出、尚未返回（提交中）：按钮置灰，禁止二次提交 */
  submitting?: boolean
  disabled?: boolean
  /** 自定义附件入口（如下拉菜单） */
  attachSlot?: ReactNode
  /** 工具栏左侧插槽（技能库等） */
  leftSlot?: ReactNode
  /** 输入框卡片右上角插槽（润色）：浮在右上角，但不占垂直空间 */
  topRightSlot?: ReactNode
  /** 工具栏右侧插槽（生图模型选择），位于发送键左边 */
  rightSlot?: ReactNode
  /** 外部信号（递增触发聚焦输入框） */
  focusSignal?: number
  /** 已上传的参考图（粘贴 / 选择） */
  attachments?: ComposerAttachment[]
  onRemoveAttachment?: (id: string) => void
  /** 从剪贴板或拖拽拿到图片文件 */
  onImageFiles?: (files: File[]) => void
  /** 上传中：附件区显示占位 */
  uploading?: boolean
  placeholder?: string
}

/**
 * 纯生图的提示词输入框。
 *
 * 与旧版的区别：**没有对话/生图双模式**——本项目只做生图，模式切换只会让用户
 * 犹豫「我这句话会走哪条链路」。现在只有一条链路：先分析需求，再决定是否澄清。
 *
 * 回车规则（三条缺一不可）：
 * 1. 输入法组合态（选词中）回车 = 上屏，绝不能发送；
 * 2. 空内容回车 = 保留原生换行行为；
 * 3. 提交中回车 = 忽略，避免重复发起请求。
 */
export function ChatTextarea({
  value,
  onChange,
  onSend,
  onStop,
  sending,
  submitting,
  disabled,
  attachSlot,
  leftSlot,
  topRightSlot,
  rightSlot,
  focusSignal,
  attachments = [],
  onRemoveAttachment,
  onImageFiles,
  uploading,
  placeholder,
}: ChatTextareaProps) {
  const { t } = useTranslation('chat')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (focusSignal) ref.current?.focus()
  }, [focusSignal])

  // 桌面端进入页面即聚焦，用户不用先点一下才能打字
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!window.matchMedia?.('(pointer: fine)').matches) return
    ref.current?.focus()
  }, [])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (submitting) {
      e.preventDefault()
      return
    }
    if (!value.trim()) return
    e.preventDefault()
    if (!disabled) onSend()
  }

  /** 剪贴板里的图片直接变成参考图（截图 → Ctrl+V 就能用）。 */
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onImageFiles) return
    const files: File[] = []
    const items = event.clipboardData?.items
    if (items) {
      for (const item of Array.from(items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length === 0) return
    event.preventDefault()
    onImageFiles(files)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!onImageFiles) return
    const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
      file.type.startsWith('image/')
    )
    if (files.length === 0) return
    event.preventDefault()
    onImageFiles(files)
  }

  const tooLong = value.length > PROMPT_MAX_LENGTH
  const showCounter = value.length >= COUNTER_VISIBLE_FROM
  const canSend = !disabled && !submitting && value.trim().length > 0 && !tooLong

  return (
    <div className="shrink-0 px-2.5 pb-2.5 pt-1">
      <div
        onDrop={handleDrop}
        onDragOver={(event) => {
          if (onImageFiles) event.preventDefault()
        }}
        className={cn(
          // 不再用 pt-[30px] 给右上角的润色按钮"让位"——那会把整张卡顶高 30px，
          // 空着一大条白边。改为让 textarea 右侧留出按钮宽度（pr），
          // 按钮浮在右上角、文字自动绕开它，垂直方向零浪费。
          'relative rounded-[14px] border bg-surface px-2.5 pb-1.5 pt-2 shadow-sheet transition-[border-color,box-shadow] focus-within:border-border-strong',
          tooLong ? 'border-danger' : 'border-border'
        )}
      >
        {/* 润色：输入框内部右上角（绝对定位，不占布局高度） */}
        {topRightSlot && (
          <div className="absolute right-1.5 top-1.5 z-[1] flex items-center">{topRightSlot}</div>
        )}

        {(attachments.length > 0 || uploading) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {attachments.map((item) => (
              <div
                key={item.id}
                className="group relative h-11 w-11 shrink-0 overflow-hidden rounded-[8px] border border-border bg-bg-subtle"
                title={item.name || '参考图'}
              >
                <img src={item.url} alt={item.name || '参考图'} className="h-full w-full object-cover" />
                {onRemoveAttachment && (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(item.id)}
                    aria-label="移除参考图"
                    className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl-[6px] bg-[rgba(10,12,20,0.65)] text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            ))}
            {uploading && (
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] border border-dashed border-border bg-bg-subtle">
                <Loader2 size={14} className="animate-spin text-text-tertiary" />
              </div>
            )}
          </div>
        )}

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value.slice(0, PROMPT_MAX_LENGTH + 200))}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder ?? t('input.placeholder')}
          rows={2}
          maxLength={PROMPT_MAX_LENGTH + 200}
          aria-label={t('input.placeholder')}
          aria-invalid={tooLong}
          className="max-h-40 min-h-[42px] w-full resize-none bg-transparent pr-[76px] text-body text-text placeholder:text-text-tertiary focus:outline-none"
        />

        <div className="flex items-center gap-1 pb-0.5">
          {leftSlot}
          {attachSlot ??
            (onImageFiles && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('input.attach')}
                onClick={() => ref.current?.focus()}
              >
                <Paperclip size={16} />
              </Button>
            ))}
          <span className="ml-auto" />
          {rightSlot}
          {sending ? (
            <Button variant="secondary" size="icon-sm" aria-label={t('input.stop')} onClick={onStop}>
              <Square size={15} />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label={submitting ? t('input.submitting') : t('input.send')}
              aria-busy={submitting}
              disabled={!canSend}
              onClick={onSend}
            >
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </Button>
          )}
        </div>
      </div>
      {(tooLong || showCounter) && (
        <div className="mt-1 flex items-center justify-end px-0.5 text-caption">
          <span className={cn('shrink-0 tabular-nums', tooLong ? 'text-danger' : 'text-text-tertiary')}>
            {tooLong
              ? t('input.too_long', { max: PROMPT_MAX_LENGTH, count: value.length })
              : `${value.length} / ${PROMPT_MAX_LENGTH}`}
          </span>
        </div>
      )}
    </div>
  )
}

/** 输入框里的「参考图」空状态提示（未上传时用于引导）。 */
export function AttachmentHint() {
  return (
    <span className="inline-flex items-center gap-1 text-micro text-text-tertiary">
      <ImageIcon size={11} /> 可直接粘贴截图
    </span>
  )
}
