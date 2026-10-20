import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Film, Map as MapIcon, Maximize, Minus, Plus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { CanvasMinimap, MINIMAP_HEIGHT, MINIMAP_WIDTH } from '../CanvasMinimap'
import {
  fitContentAnimated,
  focusSceneBox,
  viewportZoom,
  zoomViewportTo,
  type ExcalidrawApiLike,
} from '../canvas-helpers'
import type { CanvasElement } from '@/types/models'

const STORAGE_KEY = 'cs.navigator'
/** 缩放档位：按钮在这些档之间跳，比「每次 ×1.1」更可预期 */
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4]

type PanelView = 'map' | 'film' | null

function readStoredView(): PanelView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'map' || raw === 'film') return raw
    if (raw === 'none') return null
  } catch {
    /* ignore */
  }
  // 窄屏默认收起：手机上画布本来就小，再被缩略图占一块就没法画了
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 'map' : null
}

function NavButton({
  label,
  onClick,
  active,
  children,
  className,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(
            'flex h-7 min-w-7 items-center justify-center rounded-[8px] px-1 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
            active && 'bg-accent-soft text-accent-ink hover:bg-accent-soft hover:text-accent-ink',
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

interface CanvasNavigatorProps {
  api: ExcalidrawApiLike | null
  elements: CanvasElement[]
  /** 选中图片时的信息卡（由工作台渲染好传入） */
  selectionCard?: ReactNode
}

/**
 * 右下角导航器：选中图信息卡 / 全景缩略图 · 作品胶片 / 缩放条，三层自下而上叠在一列。
 *
 * 之前缩略图在左下、选中预览在右下、缩放在 Excalidraw 原生的左下角浮层里——
 * 三块「看全局」的东西散在两个角落，还和底部工具岛抢视线。现在全部收进右下一列：
 * - 最底一条缩放条常驻（− 百分比 + 适配），百分比点一下回到 100%；
 * - 上面一层可在「全景」和「胶片」间切换，或整层收起（记住偏好）；
 * - 选中图片时信息卡浮在最上面，不再压住缩略图。
 *
 * 「胶片」是画布上所有图片的缩略图墙：画布越铺越大时，点一下就飞到那张图——
 * 这是让人愿意把画布当长期创作台用的关键：东西多了也找得回来。
 */
export function CanvasNavigator({ api, elements, selectionCard }: CanvasNavigatorProps) {
  const { t } = useTranslation('stage')
  const [view, setView] = useState<PanelView>(readStoredView)
  const panelRef = useRef<HTMLDivElement>(null)
  const zoomTextRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef(true)

  const choose = (next: PanelView) => {
    const value = view === next ? null : next
    setView(value)
    try {
      localStorage.setItem(STORAGE_KEY, value ?? 'none')
    } catch {
      /* ignore */
    }
  }

  // 面板收放：高度 auto ↔ 0；首帧直接落位不播动画
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const vars = { height: view ? 'auto' : 0, autoAlpha: view ? 1 : 0 }
    if (firstRef.current || shouldReduceMotion()) gsap.set(panel, vars)
    else
      gsap.to(panel, {
        ...vars,
        duration: view ? 0.45 : 0.28,
        ease: view ? 'expo.out' : 'power2.in',
        overwrite: 'auto',
      })
    firstRef.current = false
  }, [view])

  // 选中信息卡入场：从下方轻轻弹起
  const hasCard = Boolean(selectionCard)
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !hasCard || shouldReduceMotion()) return
    const tween = gsap.from(card, { y: 10, autoAlpha: 0, scale: 0.97, duration: 0.4, ease: 'back.out(1.4)' })
    return () => {
      tween.kill()
    }
  }, [hasCard])

  // 缩放百分比：rAF 里读 appState 直接写文本，滚轮缩放时不触发 React 重渲染
  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const text = `${Math.round(viewportZoom(api) * 100)}%`
      if (text !== last && zoomTextRef.current) {
        zoomTextRef.current.textContent = text
        last = text
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [api])

  const step = (direction: 1 | -1) => {
    const current = viewportZoom(api)
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((value) => value > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1])
        : ([...ZOOM_STEPS].reverse().find((value) => value < current - 0.001) ?? ZOOM_STEPS[0])
    zoomViewportTo(api, next)
  }

  return (
    <div className="pointer-events-none absolute bottom-[calc(max(10px,env(safe-area-inset-bottom))+52px)] right-2.5 z-20 @4xl:bottom-[max(10px,env(safe-area-inset-bottom))] flex flex-col items-end gap-1.5">
      {selectionCard && (
        <div
          ref={cardRef}
          className="pointer-events-auto w-[200px] max-w-[calc(100vw-48px)] rounded-[10px] bg-surface-raised/85 p-2 shadow-sheet ring-1 ring-inset ring-border-faint backdrop-blur-md"
        >
          {selectionCard}
        </div>
      )}

      <div
        ref={panelRef}
        className="pointer-events-auto overflow-hidden rounded-[10px] bg-surface-raised/85 shadow-sheet ring-1 ring-inset ring-border-faint backdrop-blur-md"
      >
        <div className="p-1">
          {view === 'film' ? (
            <Filmstrip api={api} elements={elements} />
          ) : (
            <CanvasMinimap api={api} className="overflow-hidden" />
          )}
        </div>
      </div>

      <div
        role="toolbar"
        aria-label={t('nav.label')}
        className="pointer-events-auto flex items-center gap-px rounded-[11px] bg-surface-raised/85 p-[3px] shadow-sheet ring-1 ring-inset ring-border-faint backdrop-blur-md"
      >
        <NavButton label={t('nav.map')} active={view === 'map'} onClick={() => choose('map')}>
          <MapIcon size={15} />
        </NavButton>
        <NavButton label={t('nav.film')} active={view === 'film'} onClick={() => choose('film')}>
          <Film size={15} />
        </NavButton>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
        <NavButton label={t('nav.zoom_out')} onClick={() => step(-1)} className="hidden sm:flex">
          <Minus size={15} />
        </NavButton>
        <NavButton label={t('nav.zoom_reset')} onClick={() => zoomViewportTo(api, 1)}>
          <span ref={zoomTextRef} className="w-8 text-center text-[11px] font-semibold tabular-nums text-text">
            100%
          </span>
        </NavButton>
        <NavButton label={t('nav.zoom_in')} onClick={() => step(1)} className="hidden sm:flex">
          <Plus size={15} />
        </NavButton>
        <NavButton label={t('nav.fit')} onClick={() => fitContentAnimated(api)}>
          <Maximize size={14} />
        </NavButton>
      </div>
    </div>
  )
}

/** 作品胶片：画布上所有图片的缩略图墙，最新的在前。 */
function Filmstrip({ api, elements }: { api: ExcalidrawApiLike | null; elements: CanvasElement[] }) {
  const { t } = useTranslation('stage')
  const listRef = useRef<HTMLDivElement>(null)

  const images = useMemo(() => {
    if (!api) return []
    let files: Record<string, { dataURL?: string } | undefined> = {}
    try {
      files = api.getFiles() as typeof files
    } catch {
      return []
    }
    return elements
      .filter((el) => el.type === 'image' && !(el as { isDeleted?: boolean }).isDeleted)
      .map((el) => ({ el, url: el.fileId ? files[String(el.fileId)]?.dataURL : undefined }))
      .filter((item): item is { el: CanvasElement; url: string } => Boolean(item.url))
      .reverse()
  }, [api, elements])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || shouldReduceMotion()) return
    const tween = gsap.from(list.children, {
      scale: 0.86,
      autoAlpha: 0,
      duration: 0.36,
      stagger: 0.025,
      ease: 'back.out(1.6)',
    })
    return () => {
      tween.kill()
    }
  }, [])

  const fly = (el: CanvasElement) => {
    focusSceneBox(api, { x: el.x ?? 0, y: el.y ?? 0, w: el.width ?? 0, h: el.height ?? 0 }, { maxZoom: 1.2 })
    api?.updateScene({ appState: { selectedElementIds: { [el.id]: true } } })
  }

  if (images.length === 0) {
    return (
      <p style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }} className="flex items-center justify-center px-3 text-center text-micro leading-snug text-text-tertiary">
        {t('nav.film_empty')}
      </p>
    )
  }

  return (
    <div style={{ width: MINIMAP_WIDTH }}>
      <p className="mb-1 flex items-center justify-between px-0.5 text-micro text-text-tertiary">
        <span>{t('nav.film')}</span>
        <span className="tabular-nums">{images.length}</span>
      </p>
      <div ref={listRef} className="grid max-h-[114px] grid-cols-3 gap-1 overflow-y-auto pr-0.5">
        {images.map(({ el, url }) => (
          <button
            key={el.id}
            type="button"
            onClick={() => fly(el)}
            aria-label={t('nav.fly_to')}
            title={t('nav.fly_to')}
            className="group relative aspect-square overflow-hidden rounded-[6px] bg-mat shadow-xs ring-1 ring-inset ring-border-faint transition-shadow hover:ring-2 hover:ring-accent-strong"
          >
            <img
              src={url}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
            />
          </button>
        ))}
      </div>
    </div>
  )
}
