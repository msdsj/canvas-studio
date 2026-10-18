import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  Check,
  Copy,
  Image as ImageIcon,
  Loader2,
  Sparkles,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { canvasesApi, type SharedChat, type SharedChatMessage } from '@/lib/api/canvases'
import { pickComposeRun, pickImages } from '@/lib/api/chat'
import { getToken } from '@/lib/api/client'
import { parseServerTime } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'

export const Route = createFileRoute('/share/chat/$token')({
  component: SharedChatPage,
})

/**
 * 分享出去的对话（公开只读）。
 *
 * 正文只放两样东西：**说了什么**（消息与提示词）和**画出了什么**（结果图）。
 * 想接着做的人不需要回帖，点「复制到我这里继续创作」就会把那套提示词
 * 连同历史一起复制到他自己账号下，从零开始画——不碰原作者的任何数据。
 */
function SharedChatPage() {
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [data, setData] = useState<SharedChat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [forking, setForking] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    canvasesApi
      .getSharedChat(token)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((err: Error) => {
        if (active) setError(err.message || '分享链接无效或已关闭')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [token])

  const fork = async () => {
    if (!getToken()) {
      toast.info('先登录才能继续创作', '登录后会自动把这套内容复制到你名下')
      void navigate({ to: '/workspace' })
      return
    }
    setForking(true)
    try {
      const result = await canvasesApi.forkSharedChat(token)
      toast.success('已复制到你名下', '接下来就是你的了，随便改')
      void navigate({ to: '/workspace', search: { session: result.session_id } as never })
    } catch (err) {
      toast.error('复制失败', (err as Error).message)
    } finally {
      setForking(false)
    }
  }

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error('复制失败', '手动选中文本复制')
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-caption text-text-tertiary">
        <Loader2 size={14} className="animate-spin" /> 正在打开…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-h3 text-text">这个分享打不开了</p>
        <p className="text-caption text-text-tertiary">{error || '链接可能已关闭'}</p>
        <Button asChild size="sm" variant="secondary">
          <Link to="/workspace">去我的工作室</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-surface-subtle">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
        <span aria-hidden className="cs-logo-mark h-5 w-5" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-text">{data.title}</span>
        <span className="shrink-0 text-micro text-text-tertiary">只读</span>
        <Button size="sm" variant="primary" className="h-7 px-3 text-caption" onClick={() => void fork()}>
          {forking ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
          继续创作
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        {/* 左：对话与提示词 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-surface">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-3 p-4">
              {data.messages.map((message) => (
                <SharedMessage
                  key={message.id}
                  message={message}
                  copied={copied === message.id}
                  onCopy={() => void copy(message.content, message.id)}
                />
              ))}
              {data.messages.length === 0 && (
                <p className="py-10 text-center text-caption text-text-tertiary">这段对话没有内容</p>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* 右：画布快照 */}
        {data.canvas?.thumbnail_url && (
          <aside className="hidden w-[300px] shrink-0 flex-col overflow-hidden rounded-[14px] bg-surface p-2.5 lg:flex">
            <p className="mb-2 text-micro text-text-tertiary">画布</p>
            <img
              src={data.canvas.thumbnail_url}
              alt={data.canvas.name}
              className="w-full rounded-[10px] border border-border object-cover"
            />
          </aside>
        )}
      </div>
    </div>
  )
}

function SharedMessage({
  message,
  copied,
  onCopy,
}: {
  message: SharedChatMessage
  copied: boolean
  onCopy: () => void
}) {
  const images = pickImages(message.attachments)
  const compose = pickComposeRun(message.attachments)
  const isUser = message.role === 'user'
  const time = parseServerTime(message.created_at)

  return (
    <div className={isUser ? 'flex flex-col items-end gap-1' : 'flex flex-col items-start gap-1.5'}>
      <span className="px-1 text-micro text-text-tertiary">
        {isUser ? <User size={10} className="mr-1 inline" /> : <Sparkles size={10} className="mr-1 inline" />}
        {isUser ? '提问' : 'AI'}
        {time ? ` · ${time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
      </span>

      {images.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {images.map((image) => (
            <img
              key={image.asset_id}
              src={image.url}
              alt={image.name || '参考图'}
              className="h-16 w-16 rounded-[8px] border border-border object-cover"
            />
          ))}
        </div>
      )}

      <div
        className={
          isUser
            ? 'group relative max-w-[86%] rounded-[14px] rounded-br-[4px] bg-surface-hover px-3 py-2'
            : 'max-w-[86%] rounded-[14px] bg-accent-soft/50 px-3 py-2'
        }
      >
        <p className="whitespace-pre-wrap text-caption leading-relaxed text-text [overflow-wrap:anywhere]">
          {message.content}
        </p>
        {message.content && (
          <button
            type="button"
            onClick={onCopy}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-[5px] bg-surface/80 text-text-tertiary opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
            aria-label="复制"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
          </button>
        )}
      </div>

      {/* 提示词：别人最想看的就是这个，单独一块、可一键拿走 */}
      {compose?.final_prompt && (
        <div className="max-w-[86%] rounded-[10px] border border-border bg-surface px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <ImageIcon size={11} className="text-text-tertiary" />
            <span className="text-[10px] text-text-tertiary">提示词</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(compose.final_prompt)}
              className="ml-auto text-[10px] text-brand-text hover:underline"
            >
              复制
            </button>
          </div>
          <p className="mt-1 text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
            {compose.final_prompt}
          </p>
        </div>
      )}
    </div>
  )
}
