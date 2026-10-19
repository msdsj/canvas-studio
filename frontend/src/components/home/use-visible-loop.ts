import { useLayoutEffect, type RefObject } from 'react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

/**
 * 只在可见时播放的循环时间线（首页各个小演示共用）。
 *
 * - `build` 在 gsap.context 里执行，返回一条 timeline；卸载时整体 revert；
 * - 滚出视口立刻暂停、回来续播（IntersectionObserver）：首页同时有 4~5 段循环动画，
 *   全部常驻会把低端机的主线程吃满；
 * - 减弱动效 / 低性能设备上 `build` 根本不执行，DOM 保持 JSX 里的原样，
 *   所以每段演示的**静态 DOM 就该是「结果帧」**（过程态元素加 .cs-home-transient 隐藏）。
 * - `onCleanup` 用来登记 ResizeObserver 之类 gsap.context 管不到的资源。
 */
export function useVisibleLoop(
  ref: RefObject<HTMLElement | null>,
  build: (root: HTMLElement, onCleanup: (fn: () => void) => void) => gsap.core.Timeline | null,
  deps: unknown[] = []
) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || shouldReduceMotion()) return
    let tl: gsap.core.Timeline | null = null
    const cleanups: Array<() => void> = []
    const ctx = gsap.context(() => {
      tl = build(root, (fn) => cleanups.push(fn))
      if (!tl) return
      // 先渲染到第一帧（让时间线开头的「归零」立刻生效），再等进入视口才播放：
      // 否则静态结果帧会在开播瞬间闪成空画布
      tl.pause(0.001)
    }, root)

    // 用 IntersectionObserver 而不是 ScrollTrigger：演示可能位于被钉住的容器里，
    // ScrollTrigger 按文档流算出的可见区间在钉住期间是错的，IO 看的是真实视觉位置
    const io = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) tl?.play()
      else tl?.pause()
    })
    io.observe(root)
    cleanups.push(() => io.disconnect())

    return () => {
      cleanups.forEach((fn) => fn())
      ctx.revert()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
