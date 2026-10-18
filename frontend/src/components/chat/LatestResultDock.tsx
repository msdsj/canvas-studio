import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Copy, Download, ImagePlus, Sparkles, X } from 'lucide-react'
import { SmartImage } from '@/components/ui/smart-image'
import { gsap, Flip } from '@/lib/gsap'
import { EASE, shouldReduceMotion } from '@/lib/motion'
import { parseServerTime } from '@/lib/utils'
import type { GenerationTask } from '@/types/models'

interface LatestResultDockProps {
  /** 本次会话最近一次成功且有产出的任务 */
  task: GenerationTask
  /** 这些 url 是否已经放进画布（用于「再次放入画布」的文案与禁用态） */
  placedUrls: string[]
  /** 生图模型 id（展示用；任务参数里没有记录时退回当前选择） */
  modelLabel: string
  onPreview: (task: GenerationTask, url: string) => void
  onAddToCanvas: (task: GenerationTask) => Promise<void> | void
  onClose: () => void
}

/** 提示词预览截断长度：足够认出是哪一次生成，又不至于把展示位顶高。 */
const PROMPT_PREVIEW = 42

/**
 * 对话区底部的「最近生成」展示位。
 *
 * 时间线里的结果卡是流水账（状态 / 耗时 / 操作），最新那张图如果没有一个
 * 明确的落点，用户完成一次生成后得往下翻才能在缩略图里确认「到底画成什么样」。
 * 这里把它提升为对话底部的主角：大图 + 极简元信息 + 三个动作。
 */
export function LatestResultDock({
  task,
  placedUrls,
  modelLabel,
  onPreview,
  onAddToCanvas,
  onClose,
}: LatestResultDockProps) {
  const { t } = useTranslation('chat')
  const rootRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const urls = useMemo(() => (task.result_urls ?? []).filter(Boolean), [task.result_urls])
  const single = urls.length === 1

  /** 耗时：创建 → 完成（均按服务端 naive UTC 解析，避免差 8 小时）。 */
  const elapsed = useMemo(() => {
    const start = parseServerTime(task.created_at)?.getTime() ?? 0
    const end = parseServerTime(task.updated_at ?? task.created_at)?.getTime() ?? start
    const seconds = Math.max(0, Math.round((end - start) / 1000))
    return seconds > 0 ? `${seconds}s` : ''
  }, [task.created_at, task.updated_at])

  const allPlaced = urls.length > 0 && urls.every((url) => placedUrls.includes(url))

  // 入场：整块上浮 + 大图从遮罩里揭开（clip-path），与时间线卡片的节奏错开
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    // 首帧先把最终位置量出来（Flip.getState），再让 GSAP 从这里补回去：
    // 展示位把消息区挤矮了，时间线会整体位移，直接 fromTo 会让位移看起来是「跳」的
    const flipState = Flip.getState(root)
    const ctx = gsap.context(() => {
      gsap.fromTo(
        root,
        { y: 18, scale: 0.96, opacity: 0 },
        { y: 0, scale: 1, opacity: 1, duration: 0.52, ease: EASE.out, clearProps: 'transform,opacity' }
      )
      const media = root.querySelectorAll<HTMLElement>('[data-dock-media]')
      gsap.fromTo(
        media,
        { clipPath: 'inset(0% 0% 100% 0% round 12px)', scale: 1.04 },
        {
          clipPath: 'inset(0% 0% 0% 0% round 12px)',
          scale: 1,
          duration: 0.72,
          delay: 0.08,
          stagger: 0.07,
          ease: 'csDrop',
          clearProps: 'clipPath,transform',
        }
      )
      Flip.from(flipState, { duration: 0.42, ease: EASE.out, absolute: false })
    }, root)
    return () => ctx.revert()
    // 换了一张新结果时重新播一次；仅位置/选中变化不重播
  }, [task.id])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(task.prompt)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* 剪贴板不可用时展开提示词，用户仍可手动选中复制 */
      setExpanded(true)
    }
  }, [task.prompt])

  const handleDownload = useCallback((url: string, index: number) => {
    const a = document.createElement('a')
    a.href = url
    a.download = `canvas-${task.id.slice(0, 6)}${urls.length > 1 ? `-${index + 1}` : ''}.png`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, [task.id, urls.length])

  const handleAdd = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await onAddToCanvas(task)
    } finally {
      setBusy(false)
    }
  }, [busy, onAddToCanvas, task])

  return (
    <div ref={rootRef} className="px-3 pb-1.5 pt-2">
      <section
        aria-label={t('latest.title', { defaultValue: '最近生成' })}
        className="rounded-[16px] border border-border/70 bg-surface-raised p-2.5 shadow-sheet"
      >
        {/* 顶部极简信息：提示词（可展开 / 复制）+ 耗时 / 张数 / 模型 + 动作 */}
        <header className="mb-2 flex items-start gap-1.5">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-accent-soft text-accent-ink">
            <Sparkles size={11} />
          </span>
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            title={task.prompt}
            className="min-w-0 flex-1 text-left"
          >
            <p className="truncate text-caption font-medium text-text">
              {expanded ? t('latest.title', { defaultValue: '最近生成' }) : task.prompt.slice(0, PROMPT_PREVIEW)}
              {!expanded && task.prompt.length > PROMPT_PREVIEW ? '…' : ''}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-micro text-text-tertiary">
              {elapsed && <span className="tabular-nums">{elapsed}</span>}
              <span aria-hidden>·</span>
              <span>{t('task.result_count', { count: urls.length })}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{modelLabel}</span>
              <ChevronDown size={11} className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </p>
          </button>

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => void handleCopy()}
              title={t('task.copy_prompt', { defaultValue: '复制提示词' })}
              aria-label={t('task.copy_prompt', { defaultValue: '复制提示词' })}
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={allPlaced || busy}
              title={
                allPlaced
                  ? t('latest.already_placed', { defaultValue: '已在画布上' })
                  : t('latest.to_canvas', { defaultValue: '放入画布' })
              }
              aria-label={t('latest.to_canvas', { defaultValue: '放入画布' })}
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-accent-soft hover:text-accent-ink disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ImagePlus size={12} />
            </button>
            <button
              type="button"
              onClick={() => urls[0] && handleDownload(urls[0], 0)}
              title={t('task.download', { defaultValue: '下载' })}
              aria-label={t('task.download', { defaultValue: '下载' })}
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <Download size={12} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t('latest.close', { defaultValue: '收起' })}
              aria-label={t('latest.close', { defaultValue: '收起' })}
              className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <X size={12} />
            </button>
          </div>
        </header>

        {expanded && (
          <p className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-bg-subtle px-2.5 py-1.5 text-caption leading-relaxed text-text-secondary">
            {task.prompt}
          </p>
        )}

        {/* 大图：单张铺满（限高保留多图可比性），多张两列网格 */}
        {single ? (
          <button
            type="button"
            data-dock-media
            onClick={() => onPreview(task, urls[0])}
            className="group relative block w-full cursor-zoom-in overflow-hidden rounded-[12px] bg-mat"
            aria-label={t('task.preview', { defaultValue: '查看大图' })}
          >
            <SmartImage
              src={urls[0]}
              alt={task.prompt.slice(0, 40)}
              failedLabel={t('task.image_failed', { defaultValue: '图片加载失败' })}
              retryLabel={t('task.image_retry', { defaultValue: '重试' })}
              wrapperClassName="w-full"
              className="h-auto max-h-[46vh] w-full object-contain"
            />
            <span className="pointer-events-none absolute inset-0 rounded-[12px] ring-1 ring-inset ring-border/40 transition-[box-shadow] group-hover:ring-accent-strong/60" />
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {urls.map((url, index) => (
              <button
                key={url}
                type="button"
                data-dock-media
                onClick={() => onPreview(task, url)}
                className="group relative block aspect-square cursor-zoom-in overflow-hidden rounded-[10px] bg-mat"
                aria-label={t('task.preview', { defaultValue: '查看大图' })}
              >
                <SmartImage
                  src={url}
                  alt={`${task.prompt.slice(0, 30)} ${index + 1}`}
                  failedLabel={t('task.image_failed', { defaultValue: '图片加载失败' })}
                  retryLabel={t('task.image_retry', { defaultValue: '重试' })}
                  wrapperClassName="h-full w-full"
                  className="h-full w-full object-cover"
                />
                <span className="pointer-events-none absolute inset-0 rounded-[10px] ring-1 ring-inset ring-border/40 transition-[box-shadow] group-hover:ring-accent-strong/60" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
