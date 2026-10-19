import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion, useScrollReveal } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface FaqItem {
  q: string
  a: string
}

/**
 * 常见问题：一次只展开一条（手风琴）。
 *
 * 高度用 GSAP 从 0 补间到 auto——CSS 不能过渡到 auto，用 max-height 硬凑
 * 会出现「收起时先停顿一下」的延迟（因为 max-height 远大于实际高度）。
 */
export function FaqAccordion() {
  const { t } = useTranslation('home')
  const items = t('faq.items', { returnObjects: true }) as FaqItem[]
  const [open, setOpen] = useState<number | null>(0)
  const listRef = useRef<HTMLDivElement>(null)

  useScrollReveal(listRef, { selector: '[data-faq]', y: 16, stagger: 0.05 })

  return (
    <section id="faq" className="relative z-10 mx-auto w-full max-w-[860px] scroll-mt-20 px-4 py-16 sm:px-8 sm:py-24">
      <div className="text-center">
        <p className="text-micro font-semibold uppercase tracking-[0.14em] text-text-tertiary">FAQ</p>
        <h2 className="mt-3 font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-text sm:text-[40px]">
          {t('faq.title')}
        </h2>
      </div>
      <div ref={listRef} className="mt-10 flex flex-col gap-2">
        {items.map((item, index) => (
          <FaqRow
            key={item.q}
            item={item}
            id={`faq-${index}`}
            open={open === index}
            onToggle={() => setOpen((prev) => (prev === index ? null : index))}
          />
        ))}
      </div>
    </section>
  )
}

function FaqRow({ item, id, open, onToggle }: { item: FaqItem; id: string; open: boolean; onToggle: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const iconRef = useRef<HTMLSpanElement>(null)
  const firstRef = useRef(true)

  useLayoutEffect(() => {
    const body = bodyRef.current
    const icon = iconRef.current
    if (!body || !icon) return
    const instant = firstRef.current || shouldReduceMotion()
    firstRef.current = false
    const vars = { height: open ? 'auto' : 0, opacity: open ? 1 : 0 }
    if (instant) {
      gsap.set(body, vars)
      gsap.set(icon, { rotation: open ? 45 : 0 })
      return
    }
    gsap.to(body, { ...vars, duration: open ? 0.5 : 0.35, ease: open ? 'power3.out' : 'power2.inOut', overwrite: true })
    gsap.to(icon, { rotation: open ? 45 : 0, duration: 0.4, ease: 'back.out(2)', overwrite: true })
  }, [open])

  return (
    <div
      data-faq
      className={cn(
        'rounded-[16px] bg-surface/80 ring-1 ring-inset transition-colors duration-300',
        open ? 'ring-accent-strong/50 shadow-sheet' : 'ring-border-faint hover:bg-surface'
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-3 px-4 py-4 text-left sm:px-5"
      >
        <span className="min-w-0 flex-1 text-ui font-semibold text-text">{item.q}</span>
        <span
          ref={iconRef}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
            open ? 'bg-accent text-on-accent' : 'bg-bg-subtle text-text-tertiary'
          )}
        >
          <Plus size={14} />
        </span>
      </button>
      <div ref={bodyRef} id={id} role="region" className="overflow-hidden">
        <p className="px-4 pb-4 text-caption leading-relaxed text-text-secondary sm:px-5 sm:pb-5">{item.a}</p>
      </div>
    </div>
  )
}
