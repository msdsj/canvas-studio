import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Images, MessageSquareText, RefreshCw, Upload } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { focusAgentComposer } from './composer-bridge'

/** 灵感卡数量（locale 里 inspirations 数组的长度，每批展示 3 张） */
const BATCH = 3

interface Inspiration {
  tag: string
  title: string
  prompt: string
}

/**
 * 空画布引导。
 *
 * 空白画布是新用户流失最多的一屏：不知道第一步做什么。这里给三条明确的起手式
 * （说一句 / 传一张 / 从素材库挑），再附一组「灵感卡」——点一下就把一段写好的
 * 需求放进 Agent 输入框，用户只需要按发送。「换一批」让人愿意多看几眼，
 * 这是空状态里唯一的「玩」的元素。
 *
 * 外层 pointer-events: none：空画布上用户依然可以直接画、直接拖，引导不挡路。
 */
export function EmptyCanvas({
  onUpload,
  onPickAsset,
}: {
  onUpload: () => void
  onPickAsset: () => void
}) {
  const { t } = useTranslation('stage')
  const rootRef = useRef<HTMLDivElement>(null)
  const deckRef = useRef<HTMLDivElement>(null)
  const [batch, setBatch] = useState(0)

  const all = useMemo(() => {
    const list = t('empty.inspirations', { returnObjects: true }) as Inspiration[] | string
    return Array.isArray(list) ? list : []
  }, [t])
  const total = Math.max(1, Math.ceil(all.length / BATCH))
  const shown = all.slice((batch % total) * BATCH, (batch % total) * BATCH + BATCH)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      gsap.from('[data-empty-item]', {
        y: 16,
        autoAlpha: 0,
        duration: 0.6,
        stagger: 0.06,
        ease: 'expo.out',
        delay: 0.1,
      })
    }, root)
    return () => ctx.revert()
  }, [])

  const shuffle = () => {
    const deck = deckRef.current
    if (!deck || shouldReduceMotion()) {
      setBatch((value) => value + 1)
      return
    }
    // 旧卡片翻走 → 换数据 → 新卡片翻进：像洗牌，而不是内容突然被替换
    gsap.to(deck.children, {
      rotateX: -70,
      y: -10,
      autoAlpha: 0,
      duration: 0.22,
      stagger: 0.04,
      ease: 'power2.in',
      onComplete: () => {
        setBatch((value) => value + 1)
        requestAnimationFrame(() => {
          gsap.fromTo(
            deck.children,
            { rotateX: 70, y: 12, autoAlpha: 0 },
            { rotateX: 0, y: 0, autoAlpha: 1, duration: 0.5, stagger: 0.06, ease: 'back.out(1.5)' }
          )
        })
      },
    })
  }

  const starts = [
    { key: 'describe', icon: MessageSquareText, onClick: () => focusAgentComposer() },
    { key: 'upload', icon: Upload, onClick: onUpload },
    { key: 'assets', icon: Images, onClick: onPickAsset },
  ] as const

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center p-4 pb-20">
      <div ref={rootRef} className="pointer-events-auto w-full max-w-[560px] text-center">
        <p data-empty-item className="text-micro font-medium uppercase tracking-[0.14em] text-text-tertiary">
          {t('empty.eyebrow')}
        </p>
        <h2 data-empty-item className="mt-2 font-display text-[26px] leading-tight tracking-[-0.02em] text-text sm:text-[32px]">
          {t('empty.title')}
        </h2>
        <p data-empty-item className="mx-auto mt-2 max-w-[400px] text-caption leading-relaxed text-text-secondary">
          {t('empty.desc')}
        </p>

        <div data-empty-item className="mt-5 grid grid-cols-3 gap-2">
          {starts.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                onClick={item.onClick}
                data-motion="lift"
                className="group flex flex-col items-center gap-1.5 rounded-[14px] bg-surface/90 px-2 py-3 shadow-sheet ring-1 ring-inset ring-border-faint backdrop-blur transition-[box-shadow,background-color] hover:bg-surface hover:shadow-lift"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent-soft text-accent-ink transition-transform duration-300 group-hover:scale-110">
                  <Icon size={16} />
                </span>
                <span className="text-caption font-medium text-text">{t(`empty.start.${item.key}`)}</span>
                <span className="hidden text-micro text-text-tertiary sm:block">{t(`empty.start.${item.key}_hint`)}</span>
              </button>
            )
          })}
        </div>

        {shown.length > 0 && (
          <div data-empty-item className="mt-5">
            <div className="mb-2 flex items-center justify-between px-0.5">
              <span className="text-micro font-medium text-text-tertiary">{t('empty.inspiration_title')}</span>
              <button
                type="button"
                onClick={shuffle}
                className="group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-micro font-medium text-text-secondary hover:bg-surface hover:text-text"
              >
                <RefreshCw size={11} className="transition-transform duration-500 group-hover:rotate-180" />
                {t('empty.shuffle')}
              </button>
            </div>
            <div ref={deckRef} className="grid gap-2 sm:grid-cols-3" style={{ perspective: 800 }}>
              {shown.map((item) => (
                <button
                  key={item.title}
                  type="button"
                  onClick={() => focusAgentComposer(item.prompt)}
                  className="group relative overflow-hidden rounded-[12px] bg-surface/90 p-3 text-left shadow-sheet ring-1 ring-inset ring-border-faint backdrop-blur transition-[box-shadow] hover:shadow-lift hover:ring-accent-strong/60"
                >
                  <span className="inline-flex rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent-ink">
                    {item.tag}
                  </span>
                  <span className="mt-1.5 block text-caption font-semibold text-text">{item.title}</span>
                  <span className="mt-0.5 line-clamp-2 block text-micro leading-snug text-text-tertiary">
                    {item.prompt}
                  </span>
                  <span className="mt-1.5 block text-micro font-medium text-accent-ink opacity-0 transition-opacity group-hover:opacity-100">
                    {t('empty.use_prompt')} →
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
