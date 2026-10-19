import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, MessageSquareText, Wand2 } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { ArtSwatch } from './ArtSwatch'
import { useVisibleLoop } from './use-visible-loop'
import { asList } from '@/i18n'

/** 演示舞台的统一外壳：画布点阵底 + 圆角 + 浮起阴影 */
function Stage({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`cs-home-dots relative aspect-[5/4] w-full overflow-hidden rounded-[20px] shadow-lift ring-1 ring-border-faint ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * 演示 1 · 对话即画布：左边说一句，右边画布上就长出一张图。
 * 「飞行气泡」的位移在构建时按两端元素的实际位置算出，窗口变化时 invalidate 重算。
 */
export function ChatToCanvasDemo() {
  const { t } = useTranslation('home')
  const ref = useRef<HTMLDivElement>(null)

  useVisibleLoop(ref, (root, onCleanup) => {
    const q = gsap.utils.selector(root)
    const from = root.querySelector<HTMLElement>('[data-bubble]')
    const to = root.querySelector<HTMLElement>('[data-target]')
    const ghost = root.querySelector<HTMLElement>('[data-ghost]')
    if (!from || !to || !ghost) return null
    // 以「光点」自身为起点：它在补间开始前刚被归零（x/y=0），读到的就是静止位置
    const delta = () => {
      const a = ghost.getBoundingClientRect()
      const b = to.getBoundingClientRect()
      return { x: b.left + b.width / 2 - (a.left + a.width / 2), y: b.top + b.height / 2 - (a.top + a.height / 2) }
    }

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.4, defaults: { ease: 'csPaper' } })
    tl.set(from, { autoAlpha: 0, y: 10 })
      .set(ghost, { autoAlpha: 0, x: 0, y: 0, scale: 1 })
      .set(to, { autoAlpha: 0, scale: 0.6 })
      .set(q('[data-dots] span'), { autoAlpha: 0 })
      .to(from, { autoAlpha: 1, y: 0, duration: 0.5 }, 0.2)
      .to(q('[data-dots] span'), { autoAlpha: 1, duration: 0.2, stagger: { each: 0.15, repeat: 3, yoyo: true } }, '+=0.2')
      .set(ghost, { autoAlpha: 1 })
      .to(ghost, { x: () => delta().x, y: () => delta().y, scale: 2.4, duration: 0.85, ease: 'power3.inOut' })
      .to(ghost, { autoAlpha: 0, duration: 0.25 }, '-=0.2')
      .to(to, { autoAlpha: 1, scale: 1, duration: 0.7, ease: 'back.out(1.5)' }, '<')
      .to({}, { duration: 1.6 })
      .to([from, to], { autoAlpha: 0, duration: 0.4 })

    const ro = new ResizeObserver(() => tl.invalidate())
    ro.observe(root)
    onCleanup(() => ro.disconnect())
    return tl
  })

  return (
    <div ref={ref}>
      <Stage className="grid grid-cols-[38%_1fr]">
        <div className="flex flex-col justify-center gap-2 border-r border-border-faint bg-surface/80 p-3">
          <div
            data-bubble
            className="ml-auto rounded-[12px] rounded-br-[3px] bg-bg-subtle px-2.5 py-1.5 text-micro leading-snug text-text"
          >
            {t('story.chat.bubble')}
          </div>
          <div data-dots className="flex gap-1 pl-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="cs-home-transient h-1.5 w-1.5 rounded-full bg-accent-strong" />
            ))}
          </div>
          <span
            data-ghost
            aria-hidden
            className="cs-home-transient pointer-events-none absolute left-[19%] top-1/2 h-3 w-3 rounded-full bg-accent shadow-glow"
          />
        </div>
        <div className="relative flex items-center justify-center p-4">
          <div data-target className="aspect-[4/5] w-[58%] overflow-hidden rounded-[10px] shadow-lift">
            <ArtSwatch palette="sunset" motif="type" className="h-full w-full" />
          </div>
        </div>
      </Stage>
    </div>
  )
}

/** 演示 2 · 框选即修改：画框 → 写改法 → 只有框里被「擦」成新画面。 */
export function RegionEditDemo() {
  const { t } = useTranslation('home')
  const ref = useRef<HTMLDivElement>(null)

  useVisibleLoop(ref, (root) => {
    const q = gsap.utils.selector(root)
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.5, defaults: { ease: 'csPaper' } })
    tl.set(q('[data-box]'), { scale: 0, transformOrigin: '0% 0%', autoAlpha: 1 })
      .set(q('[data-chip]'), { autoAlpha: 0, y: 8 })
      .set(q('[data-wipe]'), { scaleX: 0, transformOrigin: '0% 50%' })
      .to(q('[data-box]'), { scale: 1, duration: 0.8, ease: 'power2.inOut' }, 0.4)
      .to(q('[data-chip]'), { autoAlpha: 1, y: 0, duration: 0.4 }, '+=0.1')
      .to(q('[data-wipe]'), { scaleX: 1, duration: 1.1, ease: 'power2.inOut' }, '+=0.5')
      .to(q('[data-chip]'), { autoAlpha: 0, duration: 0.3 }, '-=0.2')
      .to(q('[data-box]'), { autoAlpha: 0, duration: 0.4 }, '+=0.9')
      .to(q('[data-wipe]'), { autoAlpha: 0, duration: 0.5 }, '+=0.8')
      .set(q('[data-wipe]'), { autoAlpha: 1, scaleX: 0 })
    return tl
  })

  return (
    <div ref={ref}>
      <Stage className="flex items-center justify-center p-5">
        <div className="relative aspect-[4/3] w-[86%] overflow-hidden rounded-[12px] shadow-lift">
          <ArtSwatch palette="peach" motif="bottle" className="absolute inset-0" />
          {/* 框选区域：瓶身。wipe 是局部重绘后的新材质，从左往右「擦」出来 */}
          <div className="absolute left-[36%] top-[30%] h-[58%] w-[28%] overflow-hidden rounded-[6px]">
            <div data-wipe className="absolute inset-0">
              <ArtSwatch palette="ocean" motif="bottle" className="h-full w-full" />
            </div>
          </div>
          <div
            data-box
            className="cs-home-transient absolute left-[36%] top-[30%] h-[58%] w-[28%] rounded-[6px] border-2 border-accent-strong bg-accent/10"
          />
          <div
            data-chip
            className="cs-home-transient absolute left-[66%] top-[38%] flex items-center gap-1 rounded-full bg-surface px-2 py-1 text-[11px] text-text shadow-float ring-1 ring-border-faint"
          >
            <Wand2 size={11} className="text-accent-ink" />
            {t('story.region.chip')}
          </div>
        </div>
      </Stage>
    </div>
  )
}

/** 演示 3 · Agent 自动拆解：一句需求散成四条子任务，再收拢成一张成品。 */
export function DecomposeDemo() {
  const { t } = useTranslation('home')
  const ref = useRef<HTMLDivElement>(null)
  const parts = asList(t('story.decompose.parts', { returnObjects: true }))

  useVisibleLoop(ref, (root) => {
    const q = gsap.utils.selector(root)
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.4, defaults: { ease: 'csPaper' } })
    tl.set(q('[data-req]'), { autoAlpha: 0, y: -8 })
      .set(q('[data-part]'), { autoAlpha: 0, scale: 0.6, y: -24 })
      .set(q('[data-line]'), { strokeDashoffset: 1 })
      .set(q('[data-result]'), { autoAlpha: 0, y: 14 })
      .set(q('[data-tick]'), { scale: 0 })
      .to(q('[data-req]'), { autoAlpha: 1, y: 0, duration: 0.5 }, 0.2)
      .to(q('[data-line]'), { strokeDashoffset: 0, duration: 0.6, stagger: 0.08, ease: 'power2.out' })
      .to(q('[data-part]'), { autoAlpha: 1, scale: 1, y: 0, duration: 0.5, stagger: 0.1, ease: 'back.out(1.6)' }, '<0.15')
      .to(q('[data-tick]'), { scale: 1, duration: 0.3, stagger: 0.22, ease: 'back.out(2)' }, '+=0.2')
      .to(q('[data-result]'), { autoAlpha: 1, y: 0, duration: 0.6, ease: 'back.out(1.3)' }, '+=0.15')
      .to({}, { duration: 1.6 })
      .to(q('[data-req], [data-part], [data-result]'), { autoAlpha: 0, duration: 0.4 })
    return tl
  })

  return (
    <div ref={ref}>
      <Stage className="flex flex-col items-center justify-between px-4 py-5">
        <div
          data-req
          className="flex max-w-[86%] items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-micro text-text shadow-sheet ring-1 ring-border-faint"
        >
          <MessageSquareText size={12} className="shrink-0 text-accent-ink" />
          <span className="truncate">{t('story.decompose.request')}</span>
        </div>

        <svg aria-hidden viewBox="0 0 400 60" preserveAspectRatio="none" className="h-[14%] w-[88%] text-border-strong">
          {[50, 150, 250, 350].map((x) => (
            <path
              key={x}
              data-line
              d={`M200 0 C200 30 ${x} 30 ${x} 60`}
              pathLength={1}
              strokeDasharray="1"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        <div className="grid w-[94%] grid-cols-4 gap-1.5">
          {parts.map((part) => (
            <div
              key={part}
              data-part
              className="relative flex flex-col items-center gap-1 rounded-[10px] bg-surface px-1 py-2 text-center shadow-sheet ring-1 ring-border-faint"
            >
              <span
                data-tick
                className="flex h-4 w-4 items-center justify-center rounded-full bg-accent text-on-accent"
              >
                <Check size={9} strokeWidth={3} />
              </span>
              <span className="w-full truncate text-[11px] font-medium text-text">{part}</span>
            </div>
          ))}
        </div>

        <div data-result className="mt-3 flex w-[70%] items-center gap-2 rounded-[12px] bg-surface p-1.5 shadow-lift ring-1 ring-border-faint">
          <ArtSwatch palette="nebula" motif="orb" className="aspect-square w-12 shrink-0 rounded-[8px]" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-micro font-semibold text-text">{t('story.decompose.result')}</p>
            <p className="truncate text-[11px] text-text-tertiary">{t('story.decompose.result_meta')}</p>
          </div>
          <ArrowRight size={14} className="shrink-0 text-text-faint" />
        </div>
      </Stage>
    </div>
  )
}
