import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  Check,
  Copy,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Sparkles,
  User,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { canvasesApi, type SharedChat, type SharedChatMessage } from '@/lib/api/canvases'
import { pickImages } from '@/lib/api/chat'
import { getToken } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import { parseServerTime } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import { BrandMark } from '@/components/brand/BrandMark'

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
  /** 看原图：分享页里的图片默认是缩略展示，点开才看全尺寸 */
  const [preview, setPreview] = useState<string | null>(null)

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
        <BrandMark className="h-5 w-5" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-text">{data.title}</span>
        <span className="shrink-0 text-micro text-text-tertiary">只读</span>
        <Button size="sm" variant="primary" className="h-7 px-3 text-caption" onClick={() => void fork()}>
          {forking ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
          继续创作
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        {/* 左：对话与提示词 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md bg-surface">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-3 p-4">
              {data.messages.map((message) => (
                <SharedMessage
                  key={message.id}
                  message={message}
                  copied={copied === message.id}
                  onCopy={() => void copy(message.content, message.id)}
                  onPreview={setPreview}
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
          <aside className="hidden w-[300px] shrink-0 flex-col overflow-hidden rounded-md bg-surface p-2.5 lg:flex">
            <p className="mb-2 text-micro text-text-tertiary">画布</p>
            <img
              src={data.canvas.thumbnail_url}
              alt={data.canvas.name}
              className="w-full rounded-sm object-cover ring-1 ring-inset ring-border-faint"
            />
          </aside>
        )}
      </div>

      {/* 看原图：与主工作台的图片灯箱同一套语言（重遮罩 + 图上白字），
          保证"点开图片"这个动作在两个页面里是同一个体验 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6"
          onClick={() => setPreview(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-scrim text-scrim-text transition-opacity hover:opacity-80"
          >
            <X size={16} />
          </button>
          <img
            src={preview}
            alt="原图"
            className="max-h-full max-w-full rounded-sm object-contain shadow-float"
          />
        </div>
      )}
    </div>
  )
}

function SharedMessage({
  message,
  copied,
  onCopy,
  onPreview,
}: {
  message: SharedChatMessage
  copied: boolean
  onCopy: () => void
  onPreview: (url: string) => void
}) {
  const images = pickImages(message.attachments)
  const results = message.images ?? []
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
              className="h-16 w-16 rounded-xs object-cover ring-1 ring-inset ring-border-faint"
            />
          ))}
        </div>
      )}

      <div
        className={
          isUser
            ? 'group relative max-w-[86%] rounded-md rounded-br-xs bg-surface-hover px-3 py-2'
            : 'max-w-[86%] rounded-md bg-accent-soft/50 px-3 py-2'
        }
      >
        <p className="whitespace-pre-wrap text-caption leading-relaxed text-text [overflow-wrap:anywhere]">
          {message.content}
        </p>
        {message.content && (
          <button
            type="button"
            onClick={onCopy}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-xs bg-surface/80 text-text-tertiary opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
            aria-label="复制"
          >
            {copied ? <Check size={10} /> : <Copy size={10} />}
          </button>
        )}
      </div>

      {/* 「画出了什么」：分享页的主角。图要大、看一眼就知道效果，点开能看原图 */}
      {results.length > 0 && (
        <div
          className={
            results.length === 1
              ? 'w-[86%] max-w-[420px]'
              : 'grid w-[86%] max-w-[560px] grid-cols-2 gap-1.5'
          }
        >
          {results.map((url, index) => (
            <button
              key={`${message.id}-${index}`}
              type="button"
              onClick={() => onPreview(url)}
              className="group relative block overflow-hidden rounded-sm bg-surface shadow-sheet ring-1 ring-inset ring-border-faint"
            >
              <img
                src={url}
                alt="生成结果"
                loading="lazy"
                className={cn(
                  'w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]',
                  results.length === 1 ? 'max-h-[420px]' : 'aspect-square'
                )}
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end bg-gradient-to-t from-scrim/80 to-transparent px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="inline-flex items-center gap-1 text-micro text-scrim-text">
                  <Maximize2 size={10} /> 看原图
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 提示词：别人最想看的就是这个，单独一块、可一键拿走 */}
      {message.prompt && (
        <div className="max-w-[86%] rounded-sm bg-surface px-2.5 py-2 shadow-sheet ring-1 ring-inset ring-border-faint">
          <div className="flex items-center gap-1.5">
            <ImageIcon size={11} className="text-text-tertiary" />
            <span className="text-micro text-text-tertiary">提示词</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(message.prompt ?? '')}
              className="ml-auto text-micro text-brand-text hover:underline"
            >
              复制
            </button>
          </div>
          <p className="mt-1 text-micro leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
            {message.prompt}
          </p>
        </div>
      )}
    </div>
  )
}
