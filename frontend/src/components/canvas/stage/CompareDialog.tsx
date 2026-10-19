import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronsLeftRight, X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import './stage.css'

export interface CompareSide {
  url: string
  version: number
}

interface CompareDialogProps {
  before: CompareSide
  after: CompareSide
  /** 改法标签（「高清放大」「框选修改」…） */
  opLabel: string
  onClose: () => void
}

/**
 * 版本对比：前后两版叠在同一个框里，拖动分割线看差异。
 *
 * 为什么用滑杆而不是左右并排：局部修改（换个杯子颜色、去掉一个路人）
 * 并排时眼睛要来回跳，很难看出改在哪；叠放 + 拖动时差异会「闪」出来，一眼就找到。
 *
 * 打开时分割线从右扫到中间一次（GSAP），用户立刻明白「这个是可以拖的」。
 * 分割位置写在 CSS 变量 `--split` 上，拖动只改一个变量，不触发 React 渲染。
 */
export function CompareDialog({ before, after, opLabel, onClose }: CompareDialogProps) {
  const { t } = useTranslation('stage')
  const frameRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const split = useRef({ value: 100 })

  const apply = useCallback((value: number) => {
    split.current.value = Math.min(100, Math.max(0, value))
    frameRef.current?.style.setProperty('--split', `${split.current.value}%`)
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (shouldReduceMotion()) {
      apply(50)
      return
    }
    const ctx = gsap.context(() => {
      gsap.fromTo(root, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.24, ease: 'power2.out' })
      gsap.fromTo(
        '[data-compare-frame]',
        { scale: 0.96, y: 12 },
        { scale: 1, y: 0, duration: 0.5, ease: 'expo.out' }
      )
      gsap.fromTo(
        split.current,
        { value: 100 },
        {
          value: 50,
          duration: 1.1,
          delay: 0.2,
          ease: 'power3.inOut',
          onUpdate: () => apply(split.current.value),
        }
      )
    }, root)
    return () => ctx.revert()
  }, [apply])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') apply(split.current.value - 5)
      if (event.key === 'ArrowRight') apply(split.current.value + 5)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [apply, onClose])

  const onPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.type === 'pointermove' && event.buttons === 0 && event.pointerType === 'mouse') return
    const frame = frameRef.current
    if (!frame) return
    gsap.killTweensOf(split.current)
    const box = frame.getBoundingClientRect()
    apply(((event.clientX - box.left) / box.width) * 100)
  }

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('compare.title')}
      className="fixed inset-0 z-[1200] flex flex-col items-center justify-center gap-4 bg-scrim p-4 sm:p-8"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label={t('compare.close')}
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-scrim-text/15 text-scrim-text backdrop-blur-sm transition-colors hover:bg-scrim-text/25"
      >
        <X size={18} />
      </button>

      <div
        ref={frameRef}
        data-compare-frame
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          onPointer(event)
        }}
        onPointerMove={onPointer}
        className="cs-checker relative max-h-[78vh] max-w-[min(92vw,1100px)] cursor-ew-resize touch-none select-none overflow-hidden rounded-[14px] shadow-lg"
        style={{ ['--split' as string]: '100%' }}
      >
        {/* 新版垫底（决定框的尺寸），旧版按分割线裁剪盖在上面 */}
        <img
          src={after.url}
          alt={t('compare.after', { v: after.version })}
          draggable={false}
          className="block max-h-[78vh] max-w-[min(92vw,1100px)] object-contain"
        />
        <img
          src={before.url}
          alt={t('compare.before', { v: before.version })}
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
          style={{ clipPath: 'inset(0 calc(100% - var(--split)) 0 0)' }}
        />
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-scrim-text shadow-[0_0_12px_rgba(0,0,0,0.45)]"
          style={{ left: 'var(--split)' }}
        >
          <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-scrim-text text-[#14130d] shadow-lift">
            <ChevronsLeftRight size={16} />
          </span>
        </span>
        <span className="absolute left-3 top-3 rounded-full bg-[rgba(12,11,7,0.62)] px-2.5 py-1 text-micro font-medium text-white backdrop-blur-sm">
          {t('compare.before', { v: before.version })}
        </span>
        <span className="absolute right-3 top-3 rounded-full bg-accent px-2.5 py-1 text-micro font-semibold text-on-accent">
          {t('compare.after', { v: after.version })}
        </span>
      </div>

      <p className="text-caption text-scrim-text/80" onClick={(event) => event.stopPropagation()}>
        {opLabel} · {t('compare.hint')}
      </p>
    </div>,
    document.body
  )
}
