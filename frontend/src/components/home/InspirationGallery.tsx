import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight } from 'lucide-react'
import { Flip, gsap } from '@/lib/gsap'
import { shouldReduceMotion, useScrollReveal } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { ArtImage } from './ArtImage'

interface GalleryItem {
  cat: string
  title: string
  prompt: string
}

/** 每张卡的「画面」：图片 / 裁切比例按序号固定分配，保证瀑布流有高低错落 */
const LOOKS: Array<{ src: string; aspect: string; position?: string }> = [
  { src: '/generated/gallery-tech.jpg', aspect: 'aspect-[4/5]', position: '50% 42%' },
  { src: '/generated/gallery-perfume.jpg', aspect: 'aspect-square', position: '50% 45%' },
  { src: '/generated/gallery-camping.jpg', aspect: 'aspect-[3/4]' },
  { src: '/generated/gallery-logo.jpg', aspect: 'aspect-square', position: '50% 50%' },
  { src: '/generated/gallery-mountain.jpg', aspect: 'aspect-[4/3]' },
  { src: '/generated/gallery-portrait.jpg', aspect: 'aspect-[4/5]', position: '50% 32%' },
  { src: '/generated/gallery-festival.jpg', aspect: 'aspect-[3/4]', position: '50% 45%' },
  { src: '/generated/gallery-skincare.jpg', aspect: 'aspect-[4/5]', position: '50% 45%' },
  { src: '/generated/gallery-clay.jpg', aspect: 'aspect-[4/3]', position: '50% 50%' },
]

/**
 * 灵感画廊：按场景挑一张「看起来像我要的」，点「用这个开始」就把对应提示词填进首屏输入框。
 *
 * 解决的是首页最大的流失点——用户不知道第一句该说什么。
 * 交互细节：
 * - 卡片跟随指针做 3D 倾斜 + 受光点（quickTo，每帧只写 transform）；
 * - 分类切换用 Flip：留下的卡滑到新位置、新出现的卡放大淡入，而不是整页闪一下。
 */
export function InspirationGallery({ onUse }: { onUse: (prompt: string) => void }) {
  const { t } = useTranslation('home')
  const items = t('gallery.items', { returnObjects: true }) as GalleryItem[]
  const cats = t('gallery.cats', { returnObjects: true }) as Record<string, string>
  const [active, setActive] = useState<string>('all')
  const gridRef = useRef<HTMLDivElement>(null)

  useScrollReveal(gridRef, { selector: '[data-card]', y: 30, stagger: 0.06 })

  const visible = useMemo(
    () => items.map((item, index) => ({ ...item, index, show: active === 'all' || item.cat === active })),
    [items, active]
  )

  const switchCat = (cat: string) => {
    if (cat === active) return
    const grid = gridRef.current
    if (!grid || shouldReduceMotion()) {
      setActive(cat)
      return
    }
    const state = Flip.getState(grid.querySelectorAll('[data-card]'))
    setActive(cat)
    // 等 React 提交 DOM 后再从旧状态补间到新布局
    requestAnimationFrame(() => {
      Flip.from(state, {
        duration: 0.6,
        ease: 'power3.inOut',
        absolute: true,
        nested: true,
        onEnter: (els) => gsap.fromTo(els, { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.45 }),
      })
    })
  }

  return (
    <section id="gallery" className="relative z-10 mx-auto w-full max-w-[1240px] scroll-mt-20 px-4 py-16 sm:px-8 sm:py-24">
      <div className="flex flex-col items-center text-center">
        <p className="text-micro font-semibold uppercase tracking-[0.14em] text-text-tertiary">
          {t('gallery.eyebrow')}
        </p>
        <h2 className="mt-3 max-w-[640px] font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-text sm:text-[42px]">
          {t('gallery.title')}
        </h2>
        <p className="mt-3 max-w-[520px] text-ui leading-relaxed text-text-secondary">{t('gallery.subtitle')}</p>
      </div>

      {/* 分类：窄屏横向滚动，不折成两三行 */}
      <div className="-mx-4 mt-8 overflow-x-auto px-4 sm:mx-0 sm:px-0 [scrollbar-width:none]">
        <div role="tablist" className="mx-auto flex w-max gap-1.5">
          {['all', ...Object.keys(cats).filter((key) => key !== 'all')].map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active === key}
              onClick={() => switchCat(key)}
              className={cn(
                'h-8 shrink-0 rounded-full px-3.5 text-caption font-medium transition-colors duration-200',
                active === key
                  ? 'bg-brand text-text-inverse shadow-sheet'
                  : 'bg-surface/70 text-text-secondary ring-1 ring-inset ring-border hover:bg-surface hover:text-text'
              )}
            >
              {cats[key]}
            </button>
          ))}
        </div>
      </div>

      <div ref={gridRef} className="mt-8 columns-2 gap-3 sm:gap-4 md:columns-3 lg:columns-4">
        {visible.map((item) => (
          <GalleryCard
            key={`${item.cat}-${item.index}`}
            item={item}
            hidden={!item.show}
            catLabel={cats[item.cat] ?? item.cat}
            look={LOOKS[item.index % LOOKS.length]}
            useLabel={t('gallery.use')}
            onUse={() => onUse(item.prompt)}
          />
        ))}
      </div>
    </section>
  )
}

function GalleryCard({
  item,
  hidden,
  catLabel,
  look,
  useLabel,
  onUse,
}: {
  item: GalleryItem
  hidden: boolean
  catLabel: string
  look: (typeof LOOKS)[number]
  useLabel: string
  onUse: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const tiltRef = useRef<{ rx: gsap.QuickToFunc; ry: gsap.QuickToFunc } | null>(null)

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current
    if (!card || event.pointerType !== 'mouse' || shouldReduceMotion()) return
    if (!tiltRef.current) {
      tiltRef.current = {
        rx: gsap.quickTo(card, 'rotationX', { duration: 0.5, ease: 'power3.out' }),
        ry: gsap.quickTo(card, 'rotationY', { duration: 0.5, ease: 'power3.out' }),
      }
    }
    const rect = card.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width
    const py = (event.clientY - rect.top) / rect.height
    tiltRef.current.ry((px - 0.5) * 10)
    tiltRef.current.rx((0.5 - py) * 10)
    card.style.setProperty('--gx', `${px * 100}%`)
    card.style.setProperty('--gy', `${py * 100}%`)
  }

  const onLeave = () => {
    tiltRef.current?.rx(0)
    tiltRef.current?.ry(0)
  }

  return (
    <div data-card className={cn('cs-tilt-host mb-3 break-inside-avoid sm:mb-4', hidden && 'hidden')}>
      <div
        ref={cardRef}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        className="cs-tilt group relative overflow-hidden rounded-[18px] bg-surface shadow-sheet ring-1 ring-border-faint transition-shadow duration-300 hover:shadow-float"
      >
        <ArtImage
          src={look.src}
          alt={item.title}
          position={look.position}
          className={cn(
            'w-full transition-transform duration-700 ease-out group-hover:scale-[1.03]',
            look.aspect
          )}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/25 to-transparent"
        />
        <span aria-hidden className="cs-tilt-glare pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />

        <span className="absolute left-2.5 top-2.5 rounded-full bg-surface/85 px-2 py-0.5 text-[11px] font-medium text-text backdrop-blur">
          {catLabel}
        </span>

        <div className="p-3">
          <p className="text-caption font-semibold text-text">{item.title}</p>
          <p className="mt-1 line-clamp-2 text-micro leading-relaxed text-text-tertiary">{item.prompt}</p>
          {/* 触屏没有 hover：按钮常显；桌面端 hover 才浮出，保持画廊干净 */}
          <button
            type="button"
            onClick={onUse}
            className="mt-2.5 inline-flex h-8 items-center gap-1 rounded-full bg-accent px-3 text-micro font-semibold text-on-accent shadow-glow transition-[transform,opacity] duration-300 hover:brightness-105 md:translate-y-1 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100 md:focus-visible:translate-y-0 md:focus-visible:opacity-100"
          >
            {useLabel}
            <ArrowUpRight size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
