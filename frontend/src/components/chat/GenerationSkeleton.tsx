import { useEffect, useRef } from 'react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion, EASE } from '@/lib/motion'
import './streaming.css'

/**
 * 生图等待态：一张「正在显影的相纸」。
 *
 * 为什么不是三个灰方块闪一闪：生图动辄十几秒到几分钟，用户会盯着它。
 * 这里给的是一条**有方向的光**——光带从左上往右下扫过三张相纸，
 * 扫过的位置提亮、离开的位置回落，再加上青柠描边的极缓呼吸，
 * 看上去像「图像正在一点点显出来」，而不是「页面挂了」。
 *
 * 版式与结果网格同构（1 张整宽、多张两列、按真实宽高比占位），
 * 结果到达时图片直接「显影」在原位，而不是骨架消失后再把列表顶开。
 *
 * 降级：prefers-reduced-motion / 低性能设备下不扫描，只保留静态骨架与文案。
 */
export function GenerationSkeleton({
  count = 1,
  ratio = 1,
}: {
  /** 预计张数：骨架格数与最终结果网格一致，图出来时不会跳版 */
  count?: number
  /** 宽高比（宽 / 高）：骨架提前占好真实比例 */
  ratio?: number
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root || shouldReduceMotion()) return
    const frames = Array.from(root.querySelectorAll<HTMLElement>('[data-frame]'))
    const sweeps = Array.from(root.querySelectorAll<HTMLElement>('[data-sweep]'))
    if (frames.length === 0) return

    const ctx = gsap.context(() => {
      // 相纸本身：错峰呼吸（只动 opacity，合成层友好）
      gsap.to(frames, {
        opacity: 0.72,
        duration: 1.5,
        ease: 'sine.inOut',
        yoyo: true,
        repeat: -1,
        stagger: 0.18,
      })
      // 光带：横向扫过，单张之间错开一点，形成「依次显影」的错觉
      gsap.fromTo(
        sweeps,
        { xPercent: -130 },
        {
          xPercent: 130,
          duration: 1.9,
          ease: 'sine.inOut',
          repeat: -1,
          repeatDelay: 0.35,
          stagger: 0.16,
        }
      )
      // 整体入场：淡入即可，不要从下面「弹」出来（等待态不是结果，不该抢眼）
      gsap.from(frames, {
        opacity: 0,
        scale: 0.97,
        duration: 0.36,
        ease: EASE.out,
        stagger: 0.05,
        clearProps: 'scale',
      })
    }, root)

    return () => ctx.revert()
  }, [])

  return (
    <div
      ref={rootRef}
      className={count === 1 ? 'grid grid-cols-1' : 'grid grid-cols-2 gap-1.5'}
      aria-hidden
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          data-frame
          className="cs-breathe-edge cs-ghost-frame relative mx-auto w-full overflow-hidden rounded-sm"
          // 单张竖图按「高 300」反推最大宽度：9:16 在 400px 宽的面板里否则会高过一屏
          style={{
            aspectRatio: String(ratio),
            maxWidth: count === 1 ? `min(100%, ${Math.round(300 * ratio)}px)` : undefined,
          }}
        >
          {/* 相纸里的裁切线：暗示「这里将出现一张图」，比纯灰块有内容 */}
          <span className="absolute inset-[7px] rounded-xs border border-dashed border-border-strong/70" />
          <span className="absolute left-1/2 top-1/2 h-px w-2.5 -translate-x-1/2 -translate-y-1/2 bg-border-strong/60" />
          <span className="absolute left-1/2 top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-border-strong/60" />
          {/* 扫描光带：青柠，极窄、极淡，只负责「正在动」 */}
          <span
            data-sweep
            className="pointer-events-none absolute inset-y-0 left-0 w-1/2 will-change-transform"
            style={{
              backgroundImage:
                'linear-gradient(100deg, transparent 0%, color-mix(in srgb, var(--color-accent) 42%, transparent) 50%, transparent 100%)',
            }}
          />
        </div>
      ))}
    </div>
  )
}
