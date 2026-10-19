import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Palette, Puzzle, Ratio } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

/** 漂浮信号卡：位置（相对 hero）、视差深度、图标、文案 key */
const SIGNALS = [
  { key: 'skill', icon: Puzzle, pos: 'left-[2%] top-[16%]', depth: 1.4 },
  { key: 'style', icon: Palette, pos: 'left-[6%] bottom-[22%]', depth: 0.8 },
  { key: 'ratio', icon: Ratio, pos: 'right-[3%] top-[22%]', depth: 1.1 },
  { key: 'confirm', icon: CheckCircle2, pos: 'right-[7%] bottom-[18%]', depth: 1.7 },
] as const

/**
 * hero 两侧的「Agent 决策碎片」：技能、风格、比例、确认——
 * 它们是 Agent 在后台做的决定，漂在主视觉周围，暗示"有人在替你思考"。
 *
 * 只在 xl 以上出现：窄屏上它们只会和输入框抢位置。
 * 每张卡外层跟随指针（quickTo），内层自己上下漂——两层分开写，
 * 避免同一个元素上两个补间争抢 y。
 */
export function FloatingSignals() {
  const { t } = useTranslation('home')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    const layers = Array.from(root.querySelectorAll<HTMLElement>('[data-depth]'))

    const ctx = gsap.context(() => {
      gsap.from(layers.map((layer) => layer.firstElementChild), {
        opacity: 0,
        scale: 0.86,
        y: 16,
        duration: 0.8,
        stagger: 0.12,
        delay: 0.9,
        ease: 'csSnap',
      })
      layers.forEach((layer, index) => {
        gsap.to(layer.firstElementChild, {
          y: index % 2 === 0 ? -10 : 10,
          rotate: index % 2 === 0 ? -1.5 : 1.5,
          duration: 3.4 + index * 0.6,
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
          delay: 1.7 + index * 0.3,
        })
      })
    }, root)

    const setters = layers.map((layer) => ({
      x: gsap.quickTo(layer, 'x', { duration: 1, ease: 'power3.out' }),
      y: gsap.quickTo(layer, 'y', { duration: 1, ease: 'power3.out' }),
      depth: Number(layer.dataset.depth) || 1,
    }))
    const onMove = (event: PointerEvent) => {
      const dx = event.clientX / window.innerWidth - 0.5
      const dy = event.clientY / window.innerHeight - 0.5
      setters.forEach((setter) => {
        setter.x(dx * -24 * setter.depth)
        setter.y(dy * -18 * setter.depth)
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      ctx.revert()
    }
  }, [])

  return (
    <div ref={rootRef} aria-hidden className="pointer-events-none absolute inset-0 hidden xl:block">
      {SIGNALS.map((signal) => {
        const Icon = signal.icon
        return (
          <div key={signal.key} data-depth={signal.depth} className={`absolute ${signal.pos}`}>
            <div className="cs-glass flex items-center gap-2 rounded-[14px] px-3 py-2 shadow-lift ring-1 ring-inset ring-border-faint">
              <span className="flex h-6 w-6 items-center justify-center rounded-[8px] bg-accent-soft text-accent-ink">
                <Icon size={13} />
              </span>
              <span className="whitespace-nowrap text-micro font-medium text-text-secondary">
                {t(`floating.${signal.key}`)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
