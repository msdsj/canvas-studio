import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Crop, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useChatStream } from '@/hooks/use-chat-stream'
import { usePolling } from '@/hooks/use-polling'
import { useQuota } from '@/hooks/use-quota'
import { useToast } from '@/hooks/use-toast'
import { useIdempotency } from '@/hooks/use-idempotency'
import { chatApi } from '@/lib/api/chat'
import { generateApi } from '@/lib/api/generate'
import { assetsApi } from '@/lib/api/assets'
import { events } from '@/lib/events'
import { errorMessage } from '@/lib/errors'
import { useUIStore } from '@/stores/ui'
import { ChatMessage } from './ChatMessage'
import { ChatTextarea, type ChatMode } from './ChatTextarea'
import { RegionSelector, type RegionSelection } from './RegionSelector'
import { SessionSelector } from './SessionSelector'
import { GenerationResultCard } from './GenerationResultCard'
import { Spinner } from './Spinner'
import type { ChatMessage as ChatMessageType, ChatSession, GenerationTask } from '@/types/models'

interface ChatPanelProps {
  canvasId?: string
  sessionId: string | null
  onSessionChange: (id: string) => void
  onAddResultToCanvas?: (url: string, taskId: string) => void
}

/** 右侧 AI 对话面板：会话头 + 消息流 + 生成任务卡 + 输入区。 */
export function ChatPanel({ canvasId, sessionId, onSessionChange, onAddResultToCanvas }: ChatPanelProps) {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation()
  const toast = useToast()
  const { canAfford, prices } = useQuota()
  const setQuotaModalOpen = useUIStore((s) => s.setQuotaModalOpen)
  const idem = useIdempotency()

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<ChatMode>('chat')
  const [referenceFile, setReferenceFile] = useState<File | null>(null)
  const [pendingEdit, setPendingEdit] = useState<RegionSelection | null>(null)
  const [regionOpen, setRegionOpen] = useState(false)
  const [focusSignal, setFocusSignal] = useState(0)
  const [creating, setCreating] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const referencePreviewUrl = useMemo(
    () => (referenceFile ? URL.createObjectURL(referenceFile) : null),
    [referenceFile]
  )
  useEffect(
    () => () => {
      if (referencePreviewUrl) URL.revokeObjectURL(referencePreviewUrl)
    },
    [referencePreviewUrl]
  )

  // 画布端完成框选后接收编辑目标（底图 + 标记图）
  useEffect(() => {
    const onEditTarget = (payload: RegionSelection) => {
      setPendingEdit(payload)
      setMode('image')
      setFocusSignal((n) => n + 1)
      toast.info(
        t('region.received', { defaultValue: '已标记编辑区域' }),
        t('region.received_desc', { defaultValue: '请输入修改指令后发送' })
      )
    }
    events.on('edit:target', onEditTarget)
    return () => events.off('edit:target', onEditTarget)
  }, [toast, t])

  const loadMessages = useCallback(async (id: string) => {
    try {
      const page = await chatApi.listMessages(id)
      setMessages(page.items)
    } catch {
      setMessages([])
    }
  }, [])

  const loadSessions = useCallback(
    async (selectIfEmpty = true) => {
      try {
        const list = await chatApi.listSessions(canvasId)
        setSessions(list)
        if (selectIfEmpty && !sessionId && list.length > 0) {
          onSessionChange(list[0].id)
        }
        if (selectIfEmpty && list.length === 0 && !creating) {
          setCreating(true)
          const created = await chatApi.createSession({ canvas_id: canvasId })
          setSessions([created])
          onSessionChange(created.id)
          setCreating(false)
        }
      } catch {
        /* ignore */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasId, sessionId, onSessionChange, creating]
  )

  useEffect(() => {
    void loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  useEffect(() => {
    if (sessionId) void loadMessages(sessionId)
  }, [sessionId, loadMessages])

  const { data: tasks, refresh: refreshTasks } = usePolling<GenerationTask[]>(
    async () => {
      if (!sessionId) return []
      const page = await generateApi.listTasks({ session_id: sessionId, size: 20 })
      return page.items
    },
    { enabled: Boolean(sessionId), intervalMs: 2500, maxIntervalMs: 10000 }
  )

  const chatStream = useChatStream(sessionId, (info) => {
    if (info.errorCode) {
      toast.error(te(`errors.${info.errorCode.toLowerCase()}`, { defaultValue: '对话失败' }))
    }
    void loadMessages(sessionId as string)
    void refreshTasks()
    events.emit('quota:changed')
    events.emit('tasks:changed')
  })

  const guardAfford = (cost: number): boolean => {
    if (!canAfford(cost)) {
      setQuotaModalOpen(true)
      return false
    }
    return true
  }

  const send = async () => {
    const content = input.trim()
    if (!content || !sessionId) return

    if (mode === 'chat') {
      if (!guardAfford(prices.chat)) return
      chatStream.send({ content, canvasId })
      setInput('')
      return
    }

    // 生图 / 编辑（含区域编辑）
    const isEditFlow = Boolean(pendingEdit || referenceFile)
    if (!guardAfford(isEditFlow ? prices.edit : prices.image_standard)) return
    const scope = `${pendingEdit ? 'region-edit' : referenceFile ? 'edit' : 'image'}:${sessionId}`
    const key = idem.getKey(scope)
    try {
      const task = pendingEdit
        ? await generateApi.edit(
            {
              prompt: content,
              session_id: sessionId,
              canvas_id: canvasId,
              file: pendingEdit.baseFile,
              mask: pendingEdit.maskFile,
              region: pendingEdit.region,
            },
            key
          )
        : referenceFile
          ? await generateApi.edit(
              { prompt: content, session_id: sessionId, canvas_id: canvasId, file: referenceFile },
              key
            )
          : await generateApi.image(
              { prompt: content, session_id: sessionId, canvas_id: canvasId },
              key
            )
      setInput('')
      setReferenceFile(null)
      setPendingEdit(null)
      events.emit('edit:target.clear')
      events.emit('tasks:changed')
      events.emit('quota:changed')
      void refreshTasks()
    } catch (error) {
      // 失败/取消后视为新任务，换新键
      idem.resetKey(scope)
      toast.error(errorMessage(error, te))
    }
  }

  const handlePause = async (task: GenerationTask) => {
    try {
      await generateApi.pause(task.id)
      void refreshTasks()
      events.emit('tasks:changed')
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }
  const handleResume = async (task: GenerationTask) => {
    try {
      await generateApi.resume(task.id)
      void refreshTasks()
      events.emit('tasks:changed')
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }
  const handleCancel = async (task: GenerationTask) => {
    try {
      await generateApi.cancel(task.id)
      void refreshTasks()
      events.emit('quota:changed')
      events.emit('tasks:changed')
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }
  const handleRetry = (task: GenerationTask) => {
    setInput(task.prompt)
    toast.info(t('task.retry'))
  }
  const handleRegenerate = (task: GenerationTask) => {
    setInput(task.prompt)
  }
  const handleSeen = async (task: GenerationTask) => {
    try {
      await generateApi.markSeen(task.id)
      void refreshTasks()
      events.emit('tasks:changed')
    } catch {
      /* ignore */
    }
  }
  const handleAddToCanvas = (task: GenerationTask) => {
    const url = task.result_urls[0]
    if (url) onAddResultToCanvas?.(url, task.id)
  }

  /** 结果卡「编辑」：直接把生成图载入内置编辑画布（免下载上传）。 */
  const handleEditResult = (task: GenerationTask) => {
    const url = task.result_urls[0]
    if (!url) {
      toast.error(t('task.no_result', { defaultValue: '该任务没有可编辑的图片' }))
      return
    }
    events.emit('edit:open', { url })
  }

  const handleCreateSession = async () => {
    try {
      const created = await chatApi.createSession({ canvas_id: canvasId })
      setSessions((prev) => [created, ...prev])
      onSessionChange(created.id)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleDeleteSession = async (id: string) => {
    try {
      await chatApi.deleteSession(id)
      const next = sessions.filter((s) => s.id !== id)
      setSessions(next)
      if (id === sessionId) onSessionChange(next[0]?.id ?? '')
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const handleAttach = () => fileInputRef.current?.click()

  const handleFileSelected = async (file: File) => {
    setReferenceFile(file)
    try {
      await assetsApi.upload(file)
      events.emit('announcements:changed')
      toast.success('参考图已上传')
    } catch {
      /* 保留本地文件用于编辑即可 */
    }
  }

  // 展示顺序：最早的在上、最新的在下（聊天式时间线）
  const onSelectTask = useMemo(
    () =>
      [...(tasks ?? [])].sort(
        (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
      ),
    [tasks]
  )

  // 内容变化时自动滚动到最新（任务列表 / 消息）
  const scrollAnchorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const viewport = scrollAnchorRef.current?.closest('[data-radix-scroll-area-viewport]')
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [messages.length, tasks?.length])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <SessionSelector
          sessions={sessions}
          currentId={sessionId}
          onSelect={onSessionChange}
          onCreate={handleCreateSession}
          onDelete={handleDeleteSession}
        />
        <span className="text-xs text-text-tertiary">{t('panel_title')}</span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          {messages.length === 0 && onSelectTask.length === 0 && (
            <p className="py-10 text-center text-sm text-text-tertiary">{t('input.placeholder')}</p>
          )}
          {messages.map((message) => (
            <ChatMessage key={message.id} message={message} />
          ))}
          {chatStream.sending && chatStream.streamingText === '' && (
            <div className="flex gap-2">
              <Spinner status="running" />
            </div>
          )}
          {chatStream.sending && chatStream.streamingText !== '' && (
            <ChatMessage
              message={{
                id: 'streaming',
                session_id: sessionId || '',
                user_id: '',
                role: 'assistant',
                content: chatStream.streamingText,
                attachments: [],
              }}
              streaming
            />
          )}

          {onSelectTask.length > 0 && (
            <div className="flex flex-col gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {t('active_panel.title')}
              </span>
              {onSelectTask.map((task) => (
                <GenerationResultCard
                  key={task.id}
                  task={task}
                  onAddToCanvas={handleAddToCanvas}
                  onEdit={handleEditResult}
                  onRegenerate={handleRegenerate}
                  onPause={handlePause}
                  onResume={handleResume}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  onSeen={handleSeen}
                />
              ))}
            </div>
          )}
          <div ref={scrollAnchorRef} />
        </div>
      </ScrollArea>

      {(referenceFile || pendingEdit) && (
        <div className="flex items-center gap-2 border-t border-border bg-bg-subtle px-3 py-2 text-xs text-text-secondary">
          <Badge variant="brand">
            {pendingEdit ? t('region.badge', { defaultValue: '编辑区域' }) : '参考图'}
          </Badge>
          <span className="truncate">
            {referenceFile?.name ?? t('region.canvas_source', { defaultValue: '画布选区' })}
          </span>
          {pendingEdit ? (
            <>
              <Badge variant="success">{t('region.selected', { defaultValue: '已框选区域' })}</Badge>
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-surface-hover"
                onClick={() => setPendingEdit(null)}
              >
                <Crop size={12} /> {t('region.clear_selection', { defaultValue: '清除选区' })}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-brand-text hover:bg-surface-hover"
              onClick={() => setRegionOpen(true)}
            >
              <Crop size={12} /> {t('region.select', { defaultValue: '框选区域' })}
            </button>
          )}
          <button
            type="button"
            aria-label="remove"
            className="rounded p-0.5 hover:text-danger"
            onClick={() => {
              setReferenceFile(null)
              setPendingEdit(null)
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <RegionSelector
        open={regionOpen}
        onOpenChange={setRegionOpen}
        imageUrl={referencePreviewUrl}
        onConfirm={(selection) => setPendingEdit(selection)}
      />

      <ChatTextarea
        value={input}
        onChange={setInput}
        onSend={send}
        onStop={chatStream.stop}
        sending={chatStream.sending}
        mode={mode}
        onModeChange={setMode}
        onAttach={handleAttach}
        focusSignal={focusSignal}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFileSelected(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
