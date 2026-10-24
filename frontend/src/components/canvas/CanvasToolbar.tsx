import { useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { History, ImagePlus, Layers, MessageSquare, Redo2, Trash2, Undo2, Upload } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { ExcalidrawApiLike } from './canvas-helpers'

interface CanvasToolbarProps {
  /** 保留参数以兼容调用方；缩放交给 Excalidraw 原生缩放岛 */
  api?: ExcalidrawApiLike | null
  onAddImage?: () => void
  onUpload?: () => void
  onDeleteSelected?: () => void
  /** 图层面板（点图标在画布上就地弹出，不再占一条常驻侧栏） */
  layersSlot?: ReactNode
  /** 打点评论：未解决条数显示成角标 */
  onComments?: () => void
  commentCount?: number
  /** 版本历史 */
  onVersions?: () => void
  /** 撤销 / 重做（接 Excalidraw 历史栈，见 stage/use-canvas-history） */
  history?: {
    canUndo: boolean
    canRedo: boolean
    undo: () => void
    redo: () => void
    shortcut: { undo: string; redo: string }
  }
}

/**
 * dock 按钮基线：**只允许换行发生在按钮之间，绝不发生在按钮内部**。
 *
 * `shrink-0 + whitespace-nowrap` 必须同时在场：dock 是绝对定位居中的，
 * 它的可用宽度只有「容器宽 - 50%」，一旦内容超了就按 flex 规则压缩每个按钮——
 * 结果是「Add image to canvas」被压成两行、整条 dock 视觉上歪掉。
 * 高度固定 h-9（36px）保证图标按钮与文字按钮同高、基线对齐。
 */
const DOCK_BUTTON =
  'relative z-[1] flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[12px] px-2.5 text-caption font-medium text-text-secondary transition-colors duration-200 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [&_svg]:shrink-0'

/**
 * 画布浮动工具岛（底部居中，对标 Lovart 底部 dock）。
 *
 * 图标 + 文字标签（画布容器 ≥@2xl 时显示文字）：Lovart 的 dock 用文字让「这里能做什么」一眼可读，
 * 纯图标要靠 hover 猜。画布窄时只留图标（按画布容器宽度判断，而不是视口——Agent 面板展开时画布比视口窄得多）。
 *
 * hover 底色是一枚**跟随指针滑动的胶囊**（GSAP 补间），而不是每个按钮各自亮起：
 * 指针在按钮之间移动时底色连续滑过去，dock 读起来是一个整体，而不是一排散按钮。
 */
export function CanvasToolbar({
  onAddImage,
  onUpload,
  onDeleteSelected,
  layersSlot,
  history,
  onComments,
  commentCount,
  onVersions,
}: CanvasToolbarProps) {
  const { t } = useTranslation('canvas')
  const dockRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef<HTMLSpanElement>(null)

  const moveHover = (target: HTMLElement | null) => {
    const pill = hoverRef.current
    if (!pill) return
    if (!target) {
      gsap.to(pill, { autoAlpha: 0, duration: 0.2, ease: 'power2.out' })
      return
    }
    const vars = {
      x: target.offsetLeft,
      width: target.offsetWidth,
      autoAlpha: 1,
    }
    if (shouldReduceMotion()) gsap.set(pill, vars)
    // 首次出现时先瞬移到位再淡入，避免从 x=0 一路滑过来
    else if (gsap.getProperty(pill, 'autoAlpha') === 0) {
      gsap.set(pill, { x: vars.x, width: vars.width })
      gsap.to(pill, { autoAlpha: 1, duration: 0.18 })
    } else gsap.to(pill, { ...vars, duration: 0.32, ease: 'power3.out', overwrite: 'auto' })
  }

  const hoverProps = {
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => moveHover(event.currentTarget),
    onFocus: (event: React.FocusEvent<HTMLElement>) => moveHover(event.currentTarget),
  }

  return (
    <div
      ref={dockRef}
      role="toolbar"
      aria-label={t('toolbar.dock', { defaultValue: '画布工具' })}
      onPointerLeave={() => moveHover(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) moveHover(null)
      }}
      className="absolute bottom-[max(12px,env(safe-area-inset-bottom))] left-1/2 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-[16px] bg-surface-raised/95 p-1 shadow-float ring-1 ring-border-faint backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <span
        ref={hoverRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-1 h-9 rounded-[12px] bg-surface-hover opacity-0"
      />
      {/* 撤销 / 重做放在 dock 最左：普通用户不一定知道 ⌘Z，误操作后要能一眼找到「退回去」 */}
      {history && (
        <>
          {(
            [
              { key: 'undo', icon: Undo2, enabled: history.canUndo, run: history.undo },
              { key: 'redo', icon: Redo2, enabled: history.canRedo, run: history.redo },
            ] as const
          ).map((item) => {
            const Icon = item.icon
            const label = t(`stage:history.${item.key}`)
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    disabled={!item.enabled}
                    onClick={item.run}
                    {...hoverProps}
                    className={cn(DOCK_BUTTON, 'w-9 justify-center px-0 disabled:pointer-events-none disabled:opacity-35')}
                  >
                    <Icon size={16} />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {label}
                  <span className="ml-1.5 font-mono text-micro opacity-70">{history.shortcut[item.key]}</span>
                </TooltipContent>
              </Tooltip>
            )
          })}
          <span aria-hidden className="relative z-[1] mx-1 h-5 w-px shrink-0 bg-border" />
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className={DOCK_BUTTON} onClick={onAddImage} {...hoverProps}>
            <ImagePlus size={16} />
            <span className="hidden @2xl:inline">{t('toolbar.add_image')}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.add_image')}</TooltipContent>
      </Tooltip>
      {onUpload && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={DOCK_BUTTON} onClick={onUpload} {...hoverProps}>
              <Upload size={16} />
              <span className="hidden @2xl:inline">{t('toolbar.upload')}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.upload')}</TooltipContent>
        </Tooltip>
      )}
      {layersSlot && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={DOCK_BUTTON}
              aria-label={t('toolbar.layers')}
              {...hoverProps}
            >
              <Layers size={16} />
              <span className="hidden @2xl:inline">{t('toolbar.layers')}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-64 overflow-hidden p-0">
            {layersSlot}
          </PopoverContent>
        </Popover>
      )}
      <span aria-hidden className="relative z-[1] mx-1 h-5 w-px shrink-0 bg-border" />
      {onComments && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('toolbar.comments')}
              onClick={onComments}
              {...hoverProps}
              className={cn(DOCK_BUTTON, 'relative')}
            >
              <MessageSquare size={16} />
              <span className="hidden @2xl:inline">{t('toolbar.comments')}</span>
              {(commentCount ?? 0) > 0 && (
                // 窄容器（只有图标）时角标压在右上角；一旦有文字标签就回到文档流里，
                // 否则「评论」两个字会被角标盖住半格
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent-strong px-1 text-[9px] font-semibold tabular-nums text-on-accent @2xl:static">
                  {commentCount}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.comments_hint')}</TooltipContent>
        </Tooltip>
      )}
      {onVersions && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('toolbar.versions')}
              onClick={onVersions}
              {...hoverProps}
              className={DOCK_BUTTON}
            >
              <History size={16} />
              <span className="hidden @2xl:inline">{t('toolbar.versions')}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('toolbar.versions_hint')}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('toolbar.delete_selected')}
            onClick={onDeleteSelected}
            {...hoverProps}
            className={cn(DOCK_BUTTON, 'w-9 justify-center px-0 hover:text-danger')}
          >
            <Trash2 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('toolbar.delete_selected')}</TooltipContent>
      </Tooltip>
    </div>
  )
}
