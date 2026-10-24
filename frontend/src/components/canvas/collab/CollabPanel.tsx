import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  History,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { canvasesApi, type CanvasComment, type CanvasVersion } from '@/lib/api/canvases'
import { useToast } from '@/hooks/use-toast'
import { cn, parseServerTime } from '@/lib/utils'

export interface Viewport {
  zoom: number
  scrollX: number
  scrollY: number
}

/* -------------------------------------------------------------------------- */
/* 画布上的评论点                                                              */
/* -------------------------------------------------------------------------- */

interface CommentPinsProps {
  comments: CanvasComment[]
  viewport: Viewport
  /** 打点模式：点画布任意位置创建评论 */
  placing: boolean
  onPlace: (x: number, y: number) => void
  onOpen: (comment: CanvasComment) => void
  activeId?: string | null
  /** 刚打下、还没写内容的点 */
  draft?: { x: number; y: number } | null
}

export function CommentPins({ comments, viewport, placing, onPlace, onOpen, activeId, draft }: CommentPinsProps) {
  const roots = comments.filter((item) => !item.parent_id)

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!placing) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / viewport.zoom - viewport.scrollX
    const y = (event.clientY - rect.top) / viewport.zoom - viewport.scrollY
    onPlace(x, y)
  }

  return (
    <div
      onClick={handleClick}
      className={cn(
        'absolute inset-0 z-[18]',
        placing ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'
      )}
    >
      {draft && (
        <span
          style={{
            transform: `translate3d(${(draft.x + viewport.scrollX) * viewport.zoom}px, ${
              (draft.y + viewport.scrollY) * viewport.zoom
            }px, 0)`,
          }}
          className="pointer-events-none absolute -left-3 -top-3 flex h-6 w-6 animate-pulse items-center justify-center rounded-full rounded-bl-[3px] bg-brand text-[10px] font-semibold text-text-inverse ring-2 ring-surface"
        >
          +
        </span>
      )}
      {roots.map((item, index) => {
        const left = (item.x + viewport.scrollX) * viewport.zoom
        const top = (item.y + viewport.scrollY) * viewport.zoom
        const active = activeId === item.id
        return (
          <button
            key={item.id}
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onOpen(item)
            }}
            style={{ transform: `translate3d(${left}px, ${top}px, 0)` }}
            className={cn(
              'pointer-events-auto absolute -left-3 -top-3 flex h-6 min-w-6 items-center justify-center rounded-full rounded-bl-[3px] px-1 text-[10px] font-semibold tabular-nums shadow-sheet ring-2 ring-surface transition-transform',
              item.resolved
                ? 'bg-bg-subtle text-text-tertiary'
                : active
                  ? 'scale-110 bg-brand text-text-inverse'
                  : 'bg-accent-strong text-text-inverse hover:scale-105'
            )}
            title={`${item.author.name}：${item.content.slice(0, 40)}`}
          >
            {index + 1}
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 协作面板：评论 + 版本                                                       */
/* -------------------------------------------------------------------------- */

export type CollabTab = 'comments' | 'versions'

interface CollabPanelProps {
  canvasId: string
  open: boolean
  tab: CollabTab
  onTab: (tab: CollabTab) => void
  onClose: () => void
  comments: CanvasComment[]
  loading: boolean
  canWrite: boolean
  activeId?: string | null
  placing: boolean
  onTogglePlacing: () => void
  onOpenComment: (comment: CanvasComment) => void
  onAddComment: (content: string, parentId?: string | null) => Promise<unknown>
  onResolve: (id: string, resolved: boolean) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
  onRestored: () => void
}

export function CollabPanel({
  canvasId,
  open,
  tab,
  onTab,
  onClose,
  comments,
  loading,
  canWrite,
  activeId,
  placing,
  onTogglePlacing,
  onOpenComment,
  onAddComment,
  onResolve,
  onDelete,
  onRestored,
}: CollabPanelProps) {
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<CanvasComment | null>(null)
  const [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState<CanvasVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true)
    try {
      const data = await canvasesApi.listVersions(canvasId)
      setVersions(data.items)
    } catch {
      /* 面板内静默失败：顶部会有空态说明 */
    } finally {
      setVersionsLoading(false)
    }
  }, [canvasId])

  useEffect(() => {
    if (!open || tab !== 'versions') return
    void loadVersions()
  }, [open, tab, loadVersions])

  const top = comments.filter((item) => !item.parent_id)
  const repliesOf = (id: string) => comments.filter((item) => item.parent_id === id)

  const submit = async () => {
    const content = draft.trim()
    if (!content || busy) return
    setBusy(true)
    try {
      await onAddComment(content, replyTo?.id ?? null)
      setDraft('')
      setReplyTo(null)
    } catch {
      toast.error('评论发送失败', '网络恢复后再试，内容还在输入框里')
    } finally {
      setBusy(false)
    }
  }

  const saveVersion = async () => {
    try {
      await canvasesApi.createVersion(canvasId, '手动存档')
      toast.success('已存档当前版本')
      await loadVersions()
    } catch {
      toast.error('存档失败')
    }
  }

  const restore = async (version: CanvasVersion) => {
    if (!window.confirm(`恢复到「${version.label}」？当前状态会先自动存一版，可再恢复回来。`)) return
    setRestoring(version.id)
    try {
      await canvasesApi.restoreVersion(canvasId, version.id)
      toast.success('已恢复', '画布会重新加载这个版本')
      onRestored()
      await loadVersions()
    } catch {
      toast.error('恢复失败')
    } finally {
      setRestoring(null)
    }
  }

  if (!open) return null

  return (
    <aside className="absolute bottom-[72px] right-3 top-3 z-[26] flex w-[320px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-[14px] bg-surface-raised/95 shadow-float ring-1 ring-border-faint backdrop-blur-xl">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border-faint px-2">
        {(
          [
            { id: 'comments' as const, label: '评论', icon: MessageSquare },
            { id: 'versions' as const, label: '版本', icon: History },
          ]
        ).map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onTab(item.id)}
              className={cn(
                'flex h-7 items-center gap-1 rounded-full px-2 text-micro transition-colors',
                tab === item.id
                  ? 'bg-brand text-text-inverse'
                  : 'text-text-secondary hover:bg-surface-hover'
              )}
            >
              <Icon size={12} /> {item.label}
            </button>
          )
        })}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-text-tertiary hover:bg-surface-hover hover:text-text"
        >
          <X size={14} />
        </button>
      </header>

      {tab === 'comments' ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {loading && comments.length === 0 && (
              <div className="flex items-center gap-1.5 py-6 text-micro text-text-tertiary">
                <Loader2 size={12} className="animate-spin" /> 正在加载评论…
              </div>
            )}
            {!loading && top.length === 0 && (
              <div className="px-2 py-8 text-center">
                <MessageSquare size={20} className="mx-auto text-text-faint" />
                <p className="mt-2 text-caption text-text-secondary">还没有评论</p>
                <p className="mt-1 text-micro leading-relaxed text-text-faint">
                  点「在画布上打点」，在图片旁边留一句话，同事刷新就能看到
                </p>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              {top.map((item) => (
                <CommentCard
                  key={item.id}
                  item={item}
                  active={activeId === item.id}
                  replies={repliesOf(item.id)}
                  canWrite={canWrite}
                  onClick={() => onOpenComment(item)}
                  onReply={() => setReplyTo(item)}
                  onResolve={() =>
                    void onResolve(item.id, !item.resolved).catch(() => toast.error('操作失败'))
                  }
                  onDelete={() => void onDelete(item.id).catch(() => toast.error('删除失败'))}
                />
              ))}
            </div>
          </div>

          <div className="shrink-0 border-t border-border-faint p-2">
            {replyTo && (
              <div className="mb-1 flex items-center gap-1 text-micro text-text-tertiary">
                回复 {replyTo.author.name}
                <button type="button" onClick={() => setReplyTo(null)} className="text-text-faint hover:text-text">
                  <X size={10} />
                </button>
              </div>
            )}
            <div className="flex items-end gap-1.5">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, 2000))}
                rows={2}
                placeholder={canWrite ? '写评论，@昵称 可提醒成员' : '查看者只能查看评论'}
                disabled={!canWrite}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                className="max-h-28 min-h-[52px] flex-1 resize-none rounded-sm bg-bg-subtle px-2 py-1.5 text-micro text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-60"
              />
              <Button size="icon-sm" aria-label="发送评论" disabled={!draft.trim() || busy || !canWrite} onClick={() => void submit()}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              </Button>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <button
                type="button"
                onClick={onTogglePlacing}
                disabled={!canWrite}
                className={cn(
                  'inline-flex h-6 items-center gap-1 rounded-full px-2 text-micro transition-colors',
                  placing ? 'bg-accent-soft text-accent-ink' : 'text-text-tertiary hover:bg-bg-subtle',
                  !canWrite && 'opacity-50'
                )}
              >
                <MessageSquare size={10} /> {placing ? '点画布任意位置打点' : '在画布上打点'}
              </button>
              <span className="text-micro text-text-faint">⌘/Ctrl + Enter 发送</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <Button
              size="sm"
              variant="secondary"
              className="mb-2 h-7 w-full text-caption"
              onClick={() => void saveVersion()}
            >
              <History size={12} /> 存档当前版本
            </Button>
            {versionsLoading && versions.length === 0 && (
              <div className="flex items-center gap-1.5 py-4 text-micro text-text-tertiary">
                <Loader2 size={12} className="animate-spin" /> 正在加载版本…
              </div>
            )}
            <div className="flex flex-col gap-1">
              {versions.map((item) => (
                <div
                  key={item.id}
                  className="rounded-sm px-2 py-1.5 shadow-sheet ring-1 ring-inset ring-border-faint"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-micro font-medium text-text">
                      {item.label}
                    </span>
                    <span className="shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-[9px] text-text-tertiary">
                      {item.kind === 'manual' ? '手动' : item.kind === 'restore' ? '恢复' : '自动'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-faint">
                    <span>{formatTime(item.created_at)}</span>
                    <span>·</span>
                    <span>{item.element_count} 个元素</span>
                    {item.author && (
                      <>
                        <span>·</span>
                        <span className="truncate">{item.author}</span>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void restore(item)}
                      disabled={!canWrite || restoring !== null}
                      className="ml-auto inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] text-brand-text transition-colors hover:bg-brand-subtle disabled:opacity-40"
                    >
                      {restoring === item.id ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <RotateCcw size={10} />
                      )}
                      恢复
                    </button>
                  </div>
                </div>
              ))}
              {!versionsLoading && versions.length === 0 && (
                <p className="px-2 py-6 text-center text-micro leading-relaxed text-text-faint">
                  还没有历史版本。每次手动存档都会出现在这里，恢复前会自动再存一版。
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  )
}

function CommentCard({
  item,
  replies,
  active,
  canWrite,
  onClick,
  onReply,
  onResolve,
  onDelete,
}: {
  item: CanvasComment
  replies: CanvasComment[]
  active: boolean
  canWrite: boolean
  onClick: () => void
  onReply: () => void
  onResolve: () => void
  onDelete: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onClick()
      }}
      className={cn(
        'cursor-pointer rounded-sm px-2 py-1.5 text-left transition-colors',
        active
          ? 'bg-brand-subtle/60 ring-1 ring-inset ring-brand/40'
          : 'bg-surface/60 ring-1 ring-inset ring-border-faint hover:bg-surface-hover',
        item.resolved && 'opacity-60'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-[9px] font-semibold text-text-secondary">
          {item.author.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="truncate text-micro font-medium text-text">{item.author.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-text-faint">{formatTime(item.created_at)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
        {item.content}
      </p>
      {item.mentions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {item.mentions.map((mention) => (
            <span key={mention.id} className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent-ink">
              @{mention.name}
            </span>
          ))}
        </div>
      )}
      {replies.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 border-l border-border pl-2">
          {replies.map((reply) => (
            <div key={reply.id}>
              <span className="text-[9px] font-medium text-text-tertiary">{reply.author.name}：</span>
              <span className="text-[10px] leading-relaxed text-text-secondary">{reply.content}</span>
            </div>
          ))}
        </div>
      )}
      {canWrite && (
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 [div:hover>&]:opacity-100">
          <button type="button" onClick={(e) => { e.stopPropagation(); onReply() }} className="text-[10px] text-text-tertiary hover:text-text">
            回复
          </button>
          <span className="text-text-faint">·</span>
          <button type="button" onClick={(e) => { e.stopPropagation(); onResolve() }} className="inline-flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-success">
            <Check size={9} /> {item.resolved ? '重新打开' : '解决'}
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onDelete() }} className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-text-tertiary hover:text-danger">
            <Trash2 size={9} /> 删除
          </button>
        </div>
      )}
    </div>
  )
}

function formatTime(value?: string | null) {
  if (!value) return ''
  const date = parseServerTime(value)
  if (!date) return ''
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return sameDay
    ? `${hh}:${mm}`
    : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hh}:${mm}`
}
