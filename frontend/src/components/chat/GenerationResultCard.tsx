import { useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AtSign,
  Check,
  CircleStop,
  Download,
  ImagePlus,
  Maximize2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SmartImage } from '@/components/ui/smart-image'
import { TaskControls } from './TaskControls'
import { GenerationSkeleton } from './GenerationSkeleton'
import { WaitStatus } from './agent/WaitStatus'
import { useStageTimer } from '@/hooks/use-stage-timer'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn, parseServerTime } from '@/lib/utils'
import { errorTextByCode } from '@/lib/errors'
import type { GenerationTask } from '@/types/models'

interface GenerationResultCardProps {
  task: GenerationTask
  /** 已放入画布的图片 URL（按 url 去重，不用任务级标记） */
  placedUrls?: string[]
  /** 有请求在途时禁用控制按钮 */
  busy?: boolean
  /** 网络断开：等待条提示「恢复后自动续上」 */
  offline?: boolean
  onAddToCanvas?: (task: GenerationTask) => void
  /** 只把其中一张放到画布（图片悬浮操作）；不传则退回整组放入 */
  onPlaceImage?: (task: GenerationTask, url: string) => void
  onRegenerate?: (task: GenerationTask) => void
  /** 硬超时后的「重试」：停掉这张并用同一需求重新出图（一步完成，避免两次请求互相挡） */
  onRetryStalled?: (task: GenerationTask) => void
  onCancel?: (task: GenerationTask) => void
  onPreview?: (task: GenerationTask, url: string) => void
  /** 把这张图作为 @ 引用插进输入框（后续指令以它为底图） */
  onReference?: (url: string) => void
}

/** 出图的等待节奏（秒）：通常 30–60s；60s 起提示偏慢，240s 交给用户决定 */
const GENERATION_TIMING = { expectedSeconds: 40, softSeconds: 60, hardSeconds: 240 }

/** 解析 `1024x1536` → 宽高比；解析不了按正方形。 */
function parseRatio(size: unknown): number {
  if (typeof size !== 'string') return 1
  const match = size.match(/^(\d+)\s*[x×*]\s*(\d+)$/i)
  if (!match) return 1
  const w = Number(match[1])
  const h = Number(match[2])
  return w > 0 && h > 0 ? w / h : 1
}

/** 宽高比 → 易读的比例标签（1:1 / 3:4 / 16:9），找不到就显示原始尺寸。 */
function ratioLabel(size: unknown): string | null {
  if (typeof size !== 'string' || !size) return null
  const ratio = parseRatio(size)
  const known: Array<[number, string]> = [
    [1, '1:1'],
    [3 / 4, '3:4'],
    [4 / 3, '4:3'],
    [2 / 3, '2:3'],
    [3 / 2, '3:2'],
    [9 / 16, '9:16'],
    [16 / 9, '16:9'],
  ]
  const hit = known.find(([value]) => Math.abs(value - ratio) < 0.02)
  return hit ? hit[1] : size
}

/** 模型 id → 短名（gpt-image-2 → GPT Image 2），未知时原样返回。 */
function modelLabel(model: unknown): string | null {
  if (typeof model !== 'string' || !model) return null
  return model
    .split(/[-_]/)
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ')
}

/**
 * 生成结果卡（对标 Lovart 的结果呈现）。
 *
 * 结构：状态行（状态 · 用时 · 模型 · 比例）→ 图片区 → 操作行。
 * - 图片区按张数自适应：1 张保留原始比例铺满；2 张并排；3–4 张两列网格；
 *   网格格子用任务的真实宽高比，竖图不会被裁成正方形；
 * - 每张图悬浮出四个动作：放到画布 / 看大图 / 作为参考 / 下载；
 * - 结果到达时播一次「显影」：从模糊、低饱和、下沉的状态清晰起来——
 *   与等待态的「相纸扫光」首尾呼应，让「图出来了」这一刻有分量。
 *
 * 不展示提示词、思考步骤等中间处理信息。
 */
export function GenerationResultCard({
  task,
  placedUrls = [],
  busy,
  offline = false,
  onAddToCanvas,
  onPlaceImage,
  onRegenerate,
  onRetryStalled,
  onCancel,
  onPreview,
  onReference,
}: GenerationResultCardProps) {
  const { t, i18n } = useTranslation('chat')
  const { t: ta } = useTranslation('agent')
  const active = task.status === 'queued' || task.status === 'running'
  const legacyPaused = task.status === 'paused'
  const failed = task.status === 'failed' || task.status === 'timeout'
  const succeeded = task.status === 'succeeded'
  const urls = useMemo(() => task.result_urls ?? [], [task.result_urls])
  const unplaced = useMemo(() => urls.filter((url) => !placedUrls.includes(url)), [urls, placedUrls])

  const params = (task.params ?? {}) as Record<string, unknown>
  const ratio = parseRatio(params.size)
  const ratioText = ratioLabel(params.size)
  const model = modelLabel(params.model)
  const expectedCount = Math.max(1, Math.min(4, Number(params.n) || 1))

  const createdAt = parseServerTime(task.created_at)?.getTime() ?? null
  const timer = useStageTimer({ active, startedAt: createdAt, ...GENERATION_TIMING })

  /** 成功后的总用时：updated_at - created_at（老数据缺字段时不显示） */
  const doneSeconds = useMemo(() => {
    if (!succeeded) return null
    const start = parseServerTime(task.created_at)?.getTime()
    const end = parseServerTime(task.updated_at)?.getTime()
    if (!start || !end || end <= start) return null
    return Math.round((end - start) / 1000)
  }, [succeeded, task.created_at, task.updated_at])

  const stageLabel =
    task.status === 'queued'
      ? t('task.queued')
      : timer.elapsed < 8
        ? ta('wait.gen_stage.compose')
        : timer.elapsed < 30
          ? ta('wait.gen_stage.render')
          : ta('wait.gen_stage.detail')

  const failText =
    task.status === 'timeout' ? t('task.timeout') : errorTextByCode(task.error_code, i18n.t)

  // 显影：只在「这张卡亲眼看着从生成中变成完成」时播放；刷新后的历史结果直接呈现
  const gridRef = useRef<HTMLDivElement>(null)
  const wasActiveRef = useRef(active)
  useLayoutEffect(() => {
    const grid = gridRef.current
    const shouldPlay = wasActiveRef.current && succeeded
    wasActiveRef.current = active
    if (!grid || !shouldPlay || shouldReduceMotion()) return
    const tiles = grid.querySelectorAll<HTMLElement>('[data-result-tile]')
    const tween = gsap.fromTo(
      tiles,
      { opacity: 0, y: 10, scale: 0.97, filter: 'blur(14px) saturate(0.2) brightness(1.15)' },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        filter: 'blur(0px) saturate(1) brightness(1)',
        duration: 1.05,
        ease: 'expo.out',
        stagger: 0.09,
        clearProps: 'filter,transform',
      }
    )
    return () => {
      tween.kill()
    }
  }, [active, succeeded])

  const handleDownload = async (url: string, index: number) => {
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `zleap-${task.id.slice(0, 6)}-${index + 1}.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
    } catch {
      window.open(url, '_blank', 'noopener')
    }
  }

  const tileAction = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="flex h-7 w-7 items-center justify-center rounded-full bg-scrim/80 text-scrim-text backdrop-blur-sm transition-[transform,background-color] duration-200 hover:scale-110 hover:bg-scrim"
    >
      {icon}
    </button>
  )

  const renderTile = (url: string, index: number) => {
    const placed = placedUrls.includes(url)
    const singleTile = urls.length === 1
    return (
      <div
        key={url}
        data-result-tile
        className="group/tile relative overflow-hidden rounded-sm bg-mat shadow-sheet ring-1 ring-inset ring-border-faint"
        style={singleTile ? undefined : { aspectRatio: String(ratio) }}
      >
        <button
          type="button"
          onClick={() => onPreview?.(task, url)}
          className={cn('block w-full cursor-zoom-in', !singleTile && 'h-full')}
          aria-label={t('task.preview')}
        >
          <SmartImage
            src={url}
            alt={task.prompt.slice(0, 40)}
            failedLabel={t('task.image_failed')}
            retryLabel={t('task.image_retry')}
            wrapperClassName={singleTile ? 'w-full' : 'h-full w-full'}
            className={
              singleTile
                ? 'h-auto max-h-[380px] w-full object-contain'
                : 'h-full w-full object-cover transition-transform duration-500 group-hover/tile:scale-[1.03]'
            }
          />
        </button>

        {/* 悬浮操作：底部渐隐条上四个动作；键盘聚焦时同样出现 */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-scrim/70 to-transparent p-1.5 pt-6 opacity-0 transition-opacity duration-200 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/tile:pointer-events-auto group-hover/tile:opacity-100">
          {!placed && (onPlaceImage || onAddToCanvas) ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                if (onPlaceImage) onPlaceImage(task, url)
                else onAddToCanvas?.(task)
              }}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-accent px-2.5 text-micro font-semibold text-on-accent shadow-glow transition-transform duration-200 hover:scale-[1.04]"
            >
              <ImagePlus size={12} /> {t('task.place_one')}
            </button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-1">
            {tileAction(t('task.preview'), <Maximize2 size={12} />, () => onPreview?.(task, url))}
            {onReference && tileAction(t('input.reference'), <AtSign size={12} />, () => onReference(url))}
            {tileAction(t('task.download'), <Download size={12} />, () => void handleDownload(url, index))}
          </span>
        </div>

        {placed && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full bg-scrim/80 px-1.5 py-0.5 text-micro leading-none text-scrim-text backdrop-blur-sm">
            <Check size={10} /> {t('task.placed')}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'w-full min-w-0 rounded-md bg-surface p-2.5 shadow-sheet ring-1 ring-inset ring-border-faint transition-shadow',
        // 生成中：青柠描边极缓呼吸，告诉用户「Agent 还在干活」
        active && 'cs-breathe-edge'
      )}
    >
      {/* 状态行：状态 · 用时 | 模型 · 比例 */}
      <div className="mb-2 flex min-w-0 items-center gap-1.5">
        {succeeded ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-micro font-medium text-text-secondary">
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-on-accent">
              <Check size={9} strokeWidth={3} />
            </span>
            {t('task.done_count', { count: urls.length })}
            {doneSeconds !== null && (
              <span className="tabular-nums text-text-tertiary">· {doneSeconds}s</span>
            )}
          </span>
        ) : failed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-micro font-medium text-danger">
            <AlertCircle size={12} /> {t(`task.${task.status}`)}
          </span>
        ) : active ? (
          <span className="cs-agent-shine shrink-0 text-micro font-medium">
            {t('task.generating_count', { count: expectedCount })}
          </span>
        ) : (
          <span className="shrink-0 text-micro font-medium text-text-tertiary">{t('task.cancelled')}</span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden">
          {model && (
            <span className="truncate rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro text-text-tertiary">
              {model}
            </span>
          )}
          {ratioText && (
            <span className="shrink-0 rounded-full bg-bg-subtle px-1.5 py-0.5 text-micro tabular-nums text-text-tertiary">
              {ratioText}
            </span>
          )}
          {task.demo && <Badge variant="warning">{t('task.result_demo')}</Badge>}
        </span>
      </div>

      {/* 演示占位图必须说清楚：用户看到写着 DEMO 的图，会以为产品坏了 */}
      {task.demo && (
        <div className="mb-2 rounded-sm border-l-2 border-warning bg-warning-subtle px-2 py-1 text-caption leading-relaxed text-warning">
          {t('demo_hint')}
        </div>
      )}

      {active && (
        <div className="mb-2">
          <GenerationSkeleton count={expectedCount} ratio={ratio} />
          <WaitStatus
            className="mt-2"
            kind="generation"
            timer={timer}
            offline={offline}
            label={stageLabel}
            onStop={onCancel ? () => onCancel(task) : undefined}
            onRetry={onRetryStalled ? () => onRetryStalled(task) : undefined}
          />
        </div>
      )}

      {succeeded && urls.length > 0 && (
        <div
          ref={gridRef}
          className={cn('mb-2 grid gap-1.5', urls.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}
        >
          {urls.map(renderTile)}
        </div>
      )}

      {failed && (
        <div className="mb-2 rounded-sm bg-danger-subtle/60 px-2.5 py-2">
          <p className="text-caption font-medium text-danger">{failText}</p>
          <p className="mt-0.5 text-micro text-text-tertiary">{t('task.failed_hint')}</p>
        </div>
      )}

      {(task.status === 'cancelled' || legacyPaused) && (
        <div className="mb-2 rounded-sm bg-bg-subtle px-2.5 py-2">
          <p className="text-caption text-text-secondary">{t('task.cancelled')}</p>
          <p className="mt-0.5 text-micro text-text-tertiary">{t('task.refunded')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {succeeded ? (
          <>
            {unplaced.length > 0 ? (
              <Button size="sm" disabled={busy} onClick={() => onAddToCanvas?.(task)}>
                <ImagePlus size={14} />
                {urls.length > 1 && unplaced.length === urls.length
                  ? t('task.add_all_to_canvas')
                  : t('task.add_to_canvas')}
              </Button>
            ) : (
              <span className="inline-flex h-8 items-center gap-1 px-1 text-caption text-text-tertiary">
                <Check size={13} className="text-success" /> {t('task.all_placed')}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onRegenerate?.(task)}
              className="ml-auto"
            >
              <RefreshCw size={14} /> {t('task.regenerate')}
            </Button>
          </>
        ) : failed ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onRegenerate?.(task)}>
            <RotateCcw size={14} /> {t('task.retry')}
          </Button>
        ) : active ? (
          onCancel && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(task)}>
              <CircleStop size={14} /> {t('task.stop')}
            </Button>
          )
        ) : (
          <TaskControls task={task} busy={busy} onCancel={onCancel} onRetry={onRegenerate} />
        )}
      </div>
    </div>
  )
}
