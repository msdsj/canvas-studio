import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, ImageDown, Loader2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { generateApi } from '@/lib/api/generate'
import { loadPlacedUrls, markUrlPlaced } from '@/lib/task-persistence'
import { SmartImage } from '@/components/ui/smart-image'
import type { GenerationTask } from '@/types/models'

interface ResultDockProps {
  sessionId: string | null
  canvasId?: string
  collapsed: boolean
  onToggle: () => void
  onAddToCanvas: (url: string, taskId: string) => void
  /** 外部触发刷新（任务状态变化时递增） */
  refreshKey?: number
  /** 顶部插槽：当前选中图片的预览面板 */
  previewSlot?: ReactNode
}

/**
 * 生成结果安全区。
 *
 * 生成的图片先落在这里，而不是直接压到画布上——画布是用户正在排布的空间，
 * 新结果砸上去会盖住已有内容。用户可以在这里预览，再决定哪张放进画布。
 * 位于对话侧边栏与画布之间，可折叠（折叠后只留一条窄边，画布拿回全部宽度）。
 *
 * 展开态是一只浮起的纸托盘（bg-surface + shadow-sheet + 14px 软角），
 * 与画布纸卡并列浮在纸底上；缩略图统一「相纸」：3px 近直角 + 白色衬边。
 */
export function ResultDock({
  sessionId,
  canvasId,
  collapsed,
  onToggle,
  onAddToCanvas,
  refreshKey = 0,
  previewSlot,
}: ResultDockProps) {
  const [tasks, setTasks] = useState<GenerationTask[]>([])
  const [loading, setLoading] = useState(false)
  // 已放入画布的图片（按 url 记，不用任务级标记：一个任务可能有多张）
  const [placedUrls, setPlacedUrls] = useState<string[]>(() => loadPlacedUrls())

  const handlePlace = (url: string, taskId: string) => {
    if (placedUrls.includes(url)) return
    markUrlPlaced(url)
    setPlacedUrls(loadPlacedUrls())
    onAddToCanvas(url, taskId)
  }

  const load = useCallback(async () => {
    if (!sessionId && !canvasId) {
      setTasks([])
      return
    }
    setLoading(true)
    try {
      const page = await generateApi.listTasks({
        session_id: sessionId || undefined,
        canvas_id: canvasId,
        status: 'succeeded',
        size: 24,
      })
      setTasks((page.items ?? []).filter((task) => task.result_urls.length > 0))
    } catch {
      /* 拉取失败保持上一次结果，不打断创作 */
    } finally {
      setLoading(false)
    }
  }, [sessionId, canvasId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const total = tasks.reduce((sum, task) => sum + task.result_urls.length, 0)

  // 折叠态：只留一条窄边 + 数量角标，把宽度还给画布
  if (collapsed) {
    return (
      <aside className="hidden w-11 shrink-0 flex-col items-center gap-2 rounded-[14px] bg-surface py-3 shadow-sheet md:flex">
        <button
          type="button"
          onClick={onToggle}
          title="展开生成结果"
          className="flex h-8 w-8 items-center justify-center rounded-[10px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <ChevronRight size={16} />
        </button>
        <ImageDown size={17} className="text-text-tertiary" />
        {total > 0 && (
          <span className="rounded-full bg-brand px-1.5 py-0.5 text-micro font-semibold leading-none text-text-inverse">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </aside>
    )
  }

  return (
    <aside className="hidden w-[176px] shrink-0 flex-col overflow-hidden rounded-[14px] bg-surface shadow-sheet md:flex">
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-2.5">
        <ImageDown size={15} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-text-secondary">
          生成结果
        </span>
        {loading && <Loader2 size={13} className="shrink-0 animate-spin text-text-tertiary" />}
        <button
          type="button"
          onClick={onToggle}
          title="收起"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <ChevronLeft size={15} />
        </button>
      </div>

      {/* 选中图片的预览（有选中时才出现，不额外占空间） */}
      {previewSlot && <div className="shrink-0 px-2 pb-2">{previewSlot}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tasks.length === 0 ? (
          <div className="mt-8 px-2 text-center text-caption leading-relaxed text-text-tertiary">
            还没有生成结果
            <br />
            在对话里描述需求试试
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {tasks.map((task) =>
              task.result_urls.map((url, index) => {
                const placed = placedUrls.includes(url)
                return (
                  <button
                    key={`${task.id}-${index}`}
                    type="button"
                    disabled={placed}
                    onClick={() => handlePlace(url, task.id)}
                    title={
                      placed
                        ? `${task.prompt.slice(0, 60)}\n已放入画布`
                        : `${task.prompt.slice(0, 60)}\n点击放入画布`
                    }
                    className={cn(
                      'group relative block w-full overflow-hidden rounded-[3px] bg-mat p-[3px] shadow-sheet',
                      'transition-shadow duration-150',
                      placed ? 'cursor-default opacity-60' : 'hover:shadow-lift'
                    )}
                  >
                    <SmartImage
                      src={url}
                      alt={task.prompt.slice(0, 20)}
                      failedLabel="图片加载失败"
                      retryLabel="重试"
                      wrapperClassName="h-[88px] w-full rounded-[3px]"
                      className="h-full w-full rounded-[3px] object-cover"
                    />
                    {/* 悬停遮罩压在照片上，与主题无关：固定用暖棕半透明 + 反白图标，
                        避免暗色主题下「亮遮罩 + 深图标」把照片糊成一片 */}
                    {!placed && (
                      <span className="absolute inset-[3px] hidden items-center justify-center rounded-[3px] bg-[rgba(12,14,24,0.5)] group-hover:flex">
                        <Plus size={18} className="text-white" />
                      </span>
                    )}
                    {placed && (
                      <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-[rgba(12,14,24,0.62)] px-1.5 py-0.5 text-micro text-white">
                        <Check size={10} /> 已放入
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 px-2.5 pb-2.5 text-caption text-text-tertiary">共 {total} 张</div>
    </aside>
  )
}
