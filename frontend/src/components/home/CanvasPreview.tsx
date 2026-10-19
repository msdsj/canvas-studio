import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Hand, ImagePlus, Layers, MousePointer2, Sparkles, Wand2 } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { ArtSwatch } from './ArtSwatch'
import { useVisibleLoop } from './use-visible-loop'

const STEP_KEYS = ['understand', 'plan', 'skill', 'generate'] as const

/**
 * 首屏下方的「产品自己演一遍」：
 *   用户一句话 → Agent 逐步分析 → 两张图在画布上组装出来 →
 *   光标框选天空 → 写下改法 → 只有框里那块被重绘。
 *
 * 这是首页最重要的说服点——不用读任何文案，看 8 秒就知道这个产品怎么用、和别家哪里不同
 * （对话 + 画布 + 框选局部改）。整段是一条 GSAP 时间线，滚出视口即暂停。
 *
 * 光标坐标按舞台实际尺寸用函数式取值计算，窗口变化时 invalidate 重算，
 * 所以任何宽度下光标都能准确落在选框角上，而不是写死像素。
 */
export function CanvasPreview() {
  const { t } = useTranslation('home')
  const rootRef = useRef<HTMLDivElement>(null)

  useVisibleLoop(rootRef, (root, onCleanup) => {
    const q = gsap.utils.selector(root)
    const stage = root.querySelector<HTMLElement>('[data-stage]')
    const box = root.querySelector<HTMLElement>('[data-box]')
    const typed = root.querySelector<HTMLElement>('[data-typed]')
    if (!stage || !box || !typed) return null
    const fullText = typed.dataset.text ?? ''

    const at = (fx: number, fy: number) => ({
      x: () => box.offsetLeft + box.offsetWidth * fx,
      y: () => box.offsetTop + box.offsetHeight * fy,
    })

    const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6, defaults: { ease: 'csPaper' } })

    // 0. 归零：每一轮都从同一张「空画布」开始
    tl.set(q('[data-user], [data-step], [data-reply], [data-edit]'), { autoAlpha: 0, y: 8 })
      .set(q('[data-card]'), { autoAlpha: 0, scale: 0.92 })
      .set(q('[data-art]'), { autoAlpha: 0, scale: 1.06 })
      .set(q('[data-skeleton]'), { autoAlpha: 1 })
      .set(box, { scale: 0, autoAlpha: 0, transformOrigin: '0% 0%' })
      .set(q('[data-patch]'), { autoAlpha: 0 })
      .set(q('[data-region-shimmer]'), { autoAlpha: 0 })
      .set(q('[data-cursor]'), { x: () => stage.clientWidth * 0.9, y: () => stage.clientHeight * 1.05, autoAlpha: 0 })
      .add(() => (typed.textContent = ''))

    // 1. 用户发话 → Agent 一步步想
    tl.to(q('[data-user]'), { autoAlpha: 1, y: 0, duration: 0.5 }, 0.3)
      .to(q('[data-step]'), { autoAlpha: 1, y: 0, duration: 0.4, stagger: 0.42 }, '+=0.25')

    // 2. 画布上先出骨架，再「显影」成图
    tl.to(q('[data-card]'), { autoAlpha: 1, scale: 1, duration: 0.6, stagger: 0.18, ease: 'back.out(1.4)' }, '-=0.6')
      .to(q('[data-art]'), { autoAlpha: 1, scale: 1, duration: 0.9, stagger: 0.25, ease: 'power2.out' }, '+=0.35')
      .to(q('[data-skeleton]'), { autoAlpha: 0, duration: 0.4, stagger: 0.25 }, '<0.3')
      .to(q('[data-reply]'), { autoAlpha: 1, y: 0, duration: 0.45 }, '-=0.3')

    // 3. 光标进场 → 按下 → 拖出选框
    tl.to(q('[data-cursor]'), { autoAlpha: 1, duration: 0.2 }, '+=0.2')
      .to(q('[data-cursor]'), { ...at(0, 0), duration: 0.9, ease: 'power3.inOut' }, '<')
      .to(q('[data-cursor-icon]'), { scale: 0.82, duration: 0.12, yoyo: true, repeat: 1 })
      .set(box, { autoAlpha: 1 })
      .to(box, { scale: 1, duration: 0.7, ease: 'power2.inOut' }, '<0.12')
      .to(q('[data-cursor]'), { ...at(1, 1), duration: 0.7, ease: 'power2.inOut' }, '<')

    // 4. 写改法：逐字打出来
    tl.to(q('[data-edit]'), { autoAlpha: 1, y: 0, duration: 0.35 }, '+=0.1').to(
      { n: 0 },
      {
        n: fullText.length,
        duration: Math.min(1.4, 0.07 * fullText.length + 0.3),
        ease: 'none',
        onUpdate() {
          typed.textContent = fullText.slice(0, Math.round(this.targets()[0].n))
        },
      }
    )

    // 5. 只重绘框里那一块
    tl.to(q('[data-cursor]'), { autoAlpha: 0, duration: 0.3 }, '+=0.15')
      .to(q('[data-region-shimmer]'), { autoAlpha: 1, duration: 0.3 }, '<')
      .to(q('[data-patch]'), { autoAlpha: 1, duration: 0.9, ease: 'power2.out' }, '+=0.7')
      .to(q('[data-region-shimmer]'), { autoAlpha: 0, duration: 0.4 }, '<0.3')
      .to(q('[data-edit]'), { autoAlpha: 0, y: -6, duration: 0.3 }, '<')

    // 6. 停一拍让人看清结果，再整体收起进入下一轮
    tl.to(q('[data-fade]'), { autoAlpha: 0, duration: 0.5 }, '+=1.8').set(q('[data-fade]'), {
      autoAlpha: 1,
    })

    const ro = new ResizeObserver(() => tl.invalidate())
    ro.observe(stage)
    onCleanup(() => ro.disconnect())
    return tl
  })

  return (
    <div
      ref={rootRef}
      className="relative mx-auto w-full max-w-[1100px] overflow-hidden rounded-[20px] bg-surface shadow-drag ring-1 ring-border-faint sm:rounded-[24px]"
    >
      {/* 窗口栏 */}
      <div className="flex h-9 items-center gap-1.5 border-b border-border-faint px-3.5">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-full bg-border-strong" />
        ))}
        <span className="ml-3 truncate text-micro text-text-tertiary">{t('preview.window')}</span>
        <span className="ml-auto hidden items-center gap-1 text-micro font-semibold text-text-secondary sm:inline-flex">
          <Sparkles size={11} className="text-accent-strong" /> 44
        </span>
      </div>

      <div data-fade className="flex">
        {/* 左：Agent 对话（≥md） */}
        <div className="hidden w-[31%] shrink-0 flex-col gap-2.5 border-r border-border-faint p-3.5 md:flex">
          <div data-user className="ml-auto max-w-[92%] rounded-[14px] rounded-br-[4px] bg-bg-subtle px-3 py-2 text-caption leading-snug text-text">
            {t('preview.user')}
          </div>
          <div className="flex flex-col gap-1.5 pt-1">
            {STEP_KEYS.map((key) => (
              <div key={key} data-step className="flex items-center gap-2 text-micro text-text-secondary">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
                  <Check size={9} strokeWidth={3} />
                </span>
                <span className="font-medium text-text">{t(`workflow.steps.${key}.title`)}</span>
                <span className="truncate text-text-faint">{t(`workflow.steps.${key}.detail`)}</span>
              </div>
            ))}
          </div>
          <div data-reply className="mt-1 text-caption leading-relaxed text-text-secondary">
            <span className="mb-1 flex items-center gap-1.5 text-micro font-semibold text-text">
              <span className="cs-logo-mark h-3.5 w-3.5" aria-hidden /> zleap Agent
            </span>
            {t('preview.reply')}
          </div>
        </div>

        {/* 右：无限画布 */}
        <div data-stage className="cs-home-dots relative aspect-[4/3] min-w-0 flex-1 sm:aspect-[16/10]">
          <div data-card className="absolute left-[6%] top-[10%] h-[74%] w-[38%] overflow-hidden rounded-[10px] shadow-lift">
            <div data-skeleton className="cs-home-transient absolute inset-0 bg-bg-subtle">
              <span className="cs-shimmer absolute inset-0" />
            </div>
            <div data-art className="absolute inset-0">
              <ArtSwatch palette="sunset" motif="type" className="h-full w-full" />
            </div>
          </div>

          <div data-card className="absolute left-[50%] top-[16%] h-[56%] w-[44%] overflow-hidden rounded-[10px] shadow-lift">
            <div data-skeleton className="cs-home-transient absolute inset-0 bg-bg-subtle">
              <span className="cs-shimmer absolute inset-0" />
            </div>
            <div data-art className="absolute inset-0">
              <ArtSwatch palette="forest" motif="mountain" className="h-full w-full" />
            </div>
          </div>

          {/* 框选区：与第二张图的「天空」对齐。补丁 = 局部重绘后的那块 */}
          <div className="absolute left-[60%] top-[19%] h-[22%] w-[26%] overflow-hidden rounded-[4px]">
            <div data-patch className="absolute inset-0">
              <ArtSwatch palette="nebula" className="h-full w-full" />
            </div>
            <span data-region-shimmer className="cs-home-transient cs-shimmer absolute inset-0" />
          </div>
          <div
            data-box
            className="absolute left-[60%] top-[19%] h-[22%] w-[26%] rounded-[4px] border-2 border-accent-strong bg-accent/10"
          >
            <span className="absolute -left-1 -top-1 h-2 w-2 rounded-[2px] bg-accent-strong" />
            <span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-[2px] bg-accent-strong" />
            <span className="absolute -top-5 left-0 rounded-[4px] bg-accent px-1.5 py-px text-[10px] font-semibold text-on-accent">
              1
            </span>
          </div>

          <div
            data-edit
            className="absolute left-[50%] top-[44%] flex max-w-[48%] items-center gap-1.5 rounded-full bg-surface px-2.5 py-1.5 shadow-float ring-1 ring-border-faint"
          >
            <Wand2 size={12} className="shrink-0 text-accent-ink" />
            <span
              data-typed
              data-text={t('preview.edit')}
              className="min-w-[2ch] truncate text-micro text-text"
            >
              {t('preview.edit')}
            </span>
          </div>

          <div data-cursor className="cs-home-transient pointer-events-none absolute left-0 top-0 z-10">
            <MousePointer2
              data-cursor-icon
              size={20}
              className="fill-text text-surface drop-shadow-md"
            />
          </div>

          {/* 底部工具岛：静态，只为让人认出「这是画布」 */}
          <div className="absolute bottom-[4%] left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-[12px] bg-surface-raised/95 p-1 shadow-lift ring-1 ring-border-faint">
            {[MousePointer2, Hand, ImagePlus, Layers].map((Icon, i) => (
              <span
                key={i}
                className={
                  i === 0
                    ? 'flex h-6 w-6 items-center justify-center rounded-[8px] bg-accent-soft text-accent-ink'
                    : 'flex h-6 w-6 items-center justify-center rounded-[8px] text-text-tertiary'
                }
              >
                <Icon size={12} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 首屏与预览之间的「抬起」：预览窗先以 3D 后仰、略缩小的姿态躺在首屏底部，
 * 随滚动被扶正、放大到 1——像把一块屏幕从桌面上竖起来给你看。
 * 只动 transform，scrub 跟手；减弱动效时直接是正面静态。
 */
export function PreviewSection() {
  const { t } = useTranslation('home')
  const wrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      gsap.fromTo(
        '[data-tilt]',
        { rotationX: 24, scale: 0.9, y: 40, transformOrigin: '50% 0%' },
        {
          rotationX: 0,
          scale: 1,
          y: 0,
          ease: 'none',
          scrollTrigger: { trigger: wrap, start: 'top bottom', end: 'top 25%', scrub: 0.6 },
        }
      )
    }, wrap)
    return () => ctx.revert()
  }, [])

  return (
    <section className="relative z-10 px-3 pb-6 sm:px-8 sm:pb-10">
      <div ref={wrapRef} className="mx-auto max-w-[1100px] [perspective:1400px]">
        <div data-tilt className="relative">
          {/* 预览窗下的青柠地光：让它像「放在发光的台面上」 */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-6 -bottom-10 top-1/3 -z-10 rounded-full bg-accent/25 blur-[80px]"
          />
          <CanvasPreview />
        </div>
        <p className="mt-4 text-center text-micro text-text-tertiary">{t('preview.caption')}</p>
      </div>
    </section>
  )
}
