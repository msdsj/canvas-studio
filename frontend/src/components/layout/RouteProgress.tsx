import { useEffect, useRef } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

/**
 * 顶部加载进度条。
 *
 * 为什么需要它：路由切换时如果目标页要等数据，界面会有 200~800ms 的"没反应"。
 * 一条 2px 的进度条能立刻告诉用户"我收到了"，这比任何入场动画都更能减少焦虑感。
 *
 * 实现要点：
 * - 用 scaleX 而不是 width（合成层，不触发布局）
 * - 只订阅 `isLoading`：TanStack Router 在 pending 期间为 true
 * - 淡出用 opacity，并延迟 120ms 复位 scaleX，避免"闪一下再消失"
 */
export function RouteProgress() {
  const isLoading = useRouterState({ select: (s) => s.isLoading })
  const barRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef<gsap.core.Tween | null>(null)

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return

    if (shouldReduceMotion()) return

    if (isLoading) {
      doneRef.current?.kill()
      gsap.killTweensOf(bar)
      gsap.set(bar, { transformOrigin: 'left center' })
      gsap.fromTo(
        bar,
        { scaleX: 0, opacity: 1 },
        { scaleX: 0.72, duration: 0.9, ease: 'power2.out' }
      )
      // 长时间加载时缓慢逼近 0.92（绝不走到 1，否则用户以为已完成却还在转）
      doneRef.current = gsap.to(bar, {
        scaleX: 0.92,
        duration: 6,
        delay: 0.9,
        ease: 'power1.out',
      })
    } else {
      doneRef.current?.kill()
      gsap.killTweensOf(bar)
      gsap.to(bar, {
        scaleX: 1,
        duration: 0.22,
        ease: 'power2.out',
        onComplete: () => {
          gsap.to(bar, {
            opacity: 0,
            duration: 0.2,
            delay: 0.1,
            onComplete: () => gsap.set(bar, { scaleX: 0 }),
          })
        },
      })
    }
  }, [isLoading])

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[3000] h-[2px] overflow-hidden"
    >
      <div
        ref={barRef}
        className="h-full w-full origin-left bg-accent-strong"
        style={{ transform: 'scaleX(0)', opacity: 0 }}
      />
    </div>
  )
}
