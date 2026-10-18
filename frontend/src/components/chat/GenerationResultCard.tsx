import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign, Check, Download, ImagePlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SmartImage } from '@/components/ui/smart-image'
import { TaskControls } from './TaskControls'
import { GenerationSkeleton } from './GenerationSkeleton'
import { parseServerTime } from '@/lib/utils'
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
  /** 把这张图作为 @ 引用插进输入框（后续指令以它为底图） */
  onReference?: (url: string) => void
}

/**
 * 生成结果卡：状态 + 结果图 + 投放/重试。
 *
 * 结果图直接嵌在这条 AI 回复里（不再单独放在侧栏大图位）；图片上保留
 * @ 引用 / 下载两个悬浮操作，卡片底部保留「放入画布 / 重新生成」。
 *
 * 不展示提示词、思考步骤等中间处理信息。
 */
export function GenerationResultCard({
  task,
  placedUrls = [],
  busy,
  onAddToCanvas,
  onRegenerate,
  onCancel,
  onPreview,
  onReference,
}: GenerationResultCardProps) {
  const { t, i18n } = useTranslation('chat')
  const active = task.status === 'queued' || task.status === 'running'
  const legacyPaused = task.status === 'paused'
  const failed = task.status === 'failed' || task.status === 'timeout'
  const succeeded = task.status === 'succeeded'
  const urls = task.result_urls ?? []
  const unplaced = useMemo(() => urls.filter((url) => !placedUrls.includes(url)), [urls, placedUrls])
  const single = urls.length === 1

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

  /** 图片上的悬浮操作：@ 引用 + 下载。 */
  const imageActions = (url: string) => (
    <div className="pointer-events-none absolute inset-[3px] flex items-start justify-end gap-0.5 p-0.5 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
      {onReference && (
        <button
          type="button"
          aria-label={t('input.reference')}
          title={t('input.reference')}
          onClick={(event) => {
            event.stopPropagation()
            onReference(url)
          }}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-scrim text-scrim-text"
        >
          <AtSign size={12} />
        </button>
      )}
      <button
        type="button"
        aria-label={t('task.download')}
        onClick={(event) => {
          event.stopPropagation()
          void handleDownload(url)
        }}
        className="flex h-6 w-6 items-center justify-center rounded-full bg-scrim text-scrim-text"
      >
        <Download size={12} />
      </button>
    </div>
  )

  return (
    <div className="w-full min-w-0 rounded-lg rounded-bl-xs bg-surface p-2.5 shadow-sheet ring-1 ring-inset ring-border-faint">
      {/* 演示占位图必须说清楚：用户看到写着 DEMO 的图，会以为产品坏了 */}
      {task.demo && (
        <div className="mb-1.5 flex items-center gap-2">
          <span className="ml-auto shrink-0">
            <Badge variant="warning">{t('task.result_demo')}</Badge>
          </span>
        </div>
      )}

      {task.demo && (
        <div className="mb-1.5 rounded-sm border-l-2 border-warning bg-warning-subtle px-2 py-1 text-caption leading-relaxed text-warning">
          {t('demo_hint')}
        </div>
      )}

      {active && (
        <div className="mb-1.5">
          <GenerationSkeleton />
          <p className="mt-1 flex items-center gap-1.5 text-caption text-text-tertiary">
            {/* 青柠小点在跑：等待中唯一的信号色 */}
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
        <div className="mb-2">
          {single ? (
            <div className="group relative overflow-hidden rounded-sm bg-mat p-[3px] shadow-sheet">
              <button
                type="button"
                onClick={() => onPreview?.(task, urls[0])}
                className="block w-full cursor-zoom-in"
                aria-label={t('task.preview')}
              >
                <SmartImage
                  src={urls[0]}
                  alt={task.prompt.slice(0, 40)}
                  failedLabel={t('task.image_failed')}
                  retryLabel={t('task.image_retry')}
                  wrapperClassName="w-full"
                  className="h-auto max-h-[360px] w-full rounded-xs object-contain"
                />
              </button>
              {imageActions(urls[0])}
              {placedUrls.includes(urls[0]) && (
                <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded-full bg-scrim px-1 py-0.5 text-micro leading-none text-scrim-text">
                  <Check size={9} /> {t('task.placed')}
                </span>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5">
              {urls.map((url) => {
                const placed = placedUrls.includes(url)
                return (
                  <div
                    key={url}
                    className="group relative aspect-square overflow-hidden rounded-sm bg-mat p-[3px] shadow-sheet"
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
                        className="h-full w-full rounded-xs object-cover"
                      />
                    </button>
                    {imageActions(url)}
                    {placed && (
                      <span className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded-full bg-scrim px-1 py-0.5 text-micro leading-none text-scrim-text">
                        <Check size={9} /> {t('task.placed')}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {failed && (
        <div className="mb-2 border-l-2 border-danger pl-2">
          <p className="text-ui text-danger">{failText}</p>
          <p className="mt-0.5 text-caption text-text-tertiary">{t('task.refunded')}</p>
        </div>
      )}

      {(task.status === 'cancelled' || legacyPaused) && (
        <div className="mb-2 border-l-2 border-border-faint pl-2">
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
