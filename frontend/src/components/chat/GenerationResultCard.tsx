import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  ChevronDown,
  Download,
  ImagePlus,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SmartImage } from '@/components/ui/smart-image'
import { TaskControls } from './TaskControls'
import { GenerationSkeleton } from './GenerationSkeleton'
import { cn, parseServerTime } from '@/lib/utils'
import { errorTextByCode } from '@/lib/errors'
import type { GenerationTask } from '@/types/models'

interface GenerationResultCardProps {
  task: GenerationTask
  /** 已放入画布的图片 URL（按 url 去重，不用任务级标记） */
  placedUrls?: string[]
  /** 有请求在途时禁用控制按钮 */
  busy?: boolean
  onAddToCanvas?: (task: GenerationTask) => void
  onRegenerate?: (task: GenerationTask) => void
  onCancel?: (task: GenerationTask) => void
  onPreview?: (task: GenerationTask, url: string) => void
  /** 时间线里已经有用户气泡时，卡片不再重复展示提示词 */
  hidePrompt?: boolean
}

/** 缩略图尺寸：单图大一点，多图统一小方块，避免把对话栏撑爆。 */
function thumbSize(count: number): string {
  return count <= 1 ? 'h-[132px] w-[132px]' : 'h-[84px] w-[84px]'
}

/** 生成结果卡：状态 + 思考过程 + 结果缩略图 + 投放/重试。 */
export function GenerationResultCard({
  task,
  placedUrls = [],
  busy,
  onAddToCanvas,
  onRegenerate,
  onCancel,
  onPreview,
  hidePrompt,
}: GenerationResultCardProps) {
  const { t, i18n } = useTranslation('chat')
  const active = task.status === 'queued' || task.status === 'running'
  const legacyPaused = task.status === 'paused'
  const failed = task.status === 'failed' || task.status === 'timeout'
  const succeeded = task.status === 'succeeded'
  const urls = task.result_urls ?? []
  const unplaced = useMemo(() => urls.filter((url) => !placedUrls.includes(url)), [urls, placedUrls])

  const params = (task.params ?? {}) as { thinking?: string[]; optimized_prompt?: string }
  const thinking = useMemo(
    () => (Array.isArray(params.thinking) ? params.thinking.filter(Boolean) : []),
    [params.thinking]
  )
  const [showThinking, setShowThinking] = useState(true)

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) return
    const created = parseServerTime(task.created_at)
    const started = created ? created.getTime() : Date.now()
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - started) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [active, task.created_at])

  const waitingHint = elapsed >= 180 ? t('task.slow_180') : elapsed >= 90 ? t('task.slow_90') : null

  const failText =
    task.status === 'timeout' ? t('task.timeout') : errorTextByCode(task.error_code, i18n.t)

  const handleDownload = async (url: string) => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `canvas-${task.id.slice(0, 6)}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      window.open(url, '_blank', 'noopener')
    }
  }

  return (
    <div className="w-full min-w-0 rounded-[14px] border border-border/60 bg-bg-subtle/60 p-2.5">
      {(task.demo || (!hidePrompt && task.prompt)) && (
        <div className="mb-1.5 flex items-center gap-2">
          {!hidePrompt && (
            <span className="min-w-0 flex-1 truncate text-caption text-text-secondary">
              {task.prompt.slice(0, 60)}
            </span>
          )}
          {task.demo && (
            <span className="ml-auto shrink-0">
              <Badge variant="warning">{t('task.result_demo')}</Badge>
            </span>
          )}
        </div>
      )}

      {/* 思考过程：把「分析 → 优化提示词 → 提交生成」摊开，别让用户对着转圈猜 */}
      {thinking.length > 0 && (
        <div className="mb-1.5 rounded-[10px] border border-border/50 bg-surface/60 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setShowThinking((prev) => !prev)}
            className="flex w-full items-center gap-1.5 text-left text-caption text-text-secondary"
          >
            <Sparkles
              size={12}
              className={cn('shrink-0', active ? 'animate-pulse text-brand' : 'text-text-tertiary')}
            />
            <span className="min-w-0 flex-1 truncate">
              {active
                ? thinking[thinking.length - 1]
                : `${t('task.thinking_title')} · ${t('task.thinking_steps', { count: thinking.length })}`}
            </span>
            <ChevronDown
              size={12}
              className={cn('shrink-0 transition-transform', showThinking && 'rotate-180')}
            />
          </button>
          {showThinking && (
            <ol className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
              {thinking.map((step, index) => (
                <li
                  key={`${index}-${step}`}
                  className="flex gap-1.5 text-caption leading-relaxed text-text-tertiary"
                >
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand/60" />
                  <span className="min-w-0 flex-1">{step}</span>
                </li>
              ))}
              {params.optimized_prompt && (
                <li className="mt-1 border-t border-border/40 pt-1 text-caption leading-relaxed text-text-tertiary">
                  <span className="text-text-secondary">{t('task.optimized_prompt')}：</span>
                  <span className="whitespace-pre-wrap">{params.optimized_prompt}</span>
                </li>
              )}
            </ol>
          )}
        </div>
      )}

      {/* 演示占位图必须说清楚：用户看到写着 DEMO 的图，会以为产品坏了 */}
      {task.demo && (
        <div className="mb-1.5 rounded-sm border-l-2 border-warning bg-warning-subtle px-2 py-1 text-caption leading-relaxed text-warning">
          {t('demo_hint')}
        </div>
      )}

      {active && (
        <div className="mb-1.5">
          <GenerationSkeleton />
          <p className="mt-1 flex items-center gap-1.5 text-caption text-text-tertiary">
            {/* 青柠小点在跑：等待中唯一的信号色，和侧栏编排的 running 态呼应 */}
            <span className="relative flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
              <span className="absolute inset-0 animate-pulse rounded-full bg-accent/40" />
              <span className="relative h-1 w-1 rounded-full bg-accent-strong" />
            </span>
            {task.status === 'queued' ? t('task.queued') : t('task.elapsed', { seconds: elapsed })}
          </p>
          {waitingHint && <p className="mt-0.5 text-caption text-warning">{waitingHint}</p>}
        </div>
      )}

      {succeeded && urls.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {urls.map((url) => {
            const placed = placedUrls.includes(url)
            return (
              <div
                key={url}
                className={cn(
                  'group relative overflow-hidden rounded-[6px] bg-mat p-[3px] shadow-sheet',
                  thumbSize(urls.length)
                )}
              >
                <button
                  type="button"
                  onClick={() => onPreview?.(task, url)}
                  className="block h-full w-full cursor-zoom-in"
                  aria-label={t('task.preview')}
                >
                  <SmartImage
                    src={url}
                    alt={task.prompt.slice(0, 40)}
                    failedLabel={t('task.image_failed')}
                    retryLabel={t('task.image_retry')}
                    wrapperClassName="h-full w-full"
                    className="h-full w-full rounded-[4px] object-cover"
                  />
                </button>
                <div className="pointer-events-none absolute inset-[3px] flex items-start justify-end p-0.5 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label={t('task.download')}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handleDownload(url)
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(12,14,24,0.55)] text-white"
                  >
                    <Download size={12} />
                  </button>
                </div>
                {placed && (
                  <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded-full bg-[rgba(12,14,24,0.62)] px-1 py-0.5 text-[9px] leading-none text-white">
                    <Check size={9} /> {t('task.placed')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {failed && (
        <div className="mb-2 border-l-2 border-danger pl-2">
          <p className="text-ui text-danger">{failText}</p>
          <p className="mt-0.5 text-caption text-text-tertiary">{t('task.refunded')}</p>
        </div>
      )}

      {(task.status === 'cancelled' || legacyPaused) && (
        <div className="mb-2 border-l-2 border-border pl-2">
          <p className="text-ui text-text-tertiary">{t('task.cancelled')}</p>
          <p className="mt-0.5 text-caption text-text-tertiary">{t('task.refunded')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {/* 成功态的重试由卡片自己的「重新生成」承担，避免同一行出现两个同名按钮 */}
        <TaskControls
          task={task}
          busy={busy}
          onCancel={onCancel}
          onRetry={succeeded ? undefined : onRegenerate}
        />
        {succeeded && unplaced.length > 0 && (
          <Button size="sm" disabled={busy} onClick={() => onAddToCanvas?.(task)}>
            <ImagePlus size={14} /> {t('task.add_to_canvas')}
          </Button>
        )}
        {succeeded && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRegenerate?.(task)}>
            <RefreshCw size={14} /> {t('task.regenerate')}
          </Button>
        )}
      </div>
    </div>
  )
}
