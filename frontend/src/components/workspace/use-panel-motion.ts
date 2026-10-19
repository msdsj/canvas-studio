import { useLayoutEffect, useRef, type RefObject } from 'react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

interface PanelMotionOptions {
  /** 在这个媒体查询命中时，面板以「推挤」方式收放（动画宽度）；否则清掉内联样式交给 CSS */
  pushQuery: string
  /** 不命中 pushQuery 时是否以「浮层」方式滑入（动画 x + 透明度）。默认 false：交给 CSS */
  overlayBelow?: boolean
  /** 浮层滑入方向：从左（-1）或从右（1） */
  from?: -1 | 1
}

/**
 * 侧栏收放动效（Agent 面板 / 工作室抽屉共用）。
 *
 * 为什么动画宽度而不是 transform：
 * 推挤式侧栏收起后，画布要真的变宽（Excalidraw 靠 ResizeObserver 重算视口），
 * 只做 translate 会留下一块空白。宽度补间只发生在开合这一下，且内容层固定宽度，
 * 不会逐帧重排里面的消息列表——这是能保持 60fps 的关键。
 *
 * 断点切换（例如把窗口拖窄到移动端）时直接落到终态，不播放动画，
 * 并清掉内联宽度，让移动端的 CSS 布局完全接管。
 */
export function usePanelMotion(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  { pushQuery, overlayBelow = false, from = -1 }: PanelMotionOptions
) {
  const firstRun = useRef(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const media = window.matchMedia(pushQuery)

    const apply = (animate: boolean) => {
      gsap.killTweensOf(el)
      const instant = !animate || shouldReduceMotion()

      if (media.matches) {
        gsap.set(el, { clearProps: 'x,transform' })
        const vars = { width: open ? 'auto' : 0, autoAlpha: open ? 1 : 0 }
        if (instant) gsap.set(el, vars)
        else
          gsap.to(el, {
            ...vars,
            // 展开用 expo：一开始快、末段长尾，像抽屉被拉开后自己滑到位；
            // 收起用 power3.inOut：干脆，不拖泥带水
            duration: open ? 0.62 : 0.4,
            ease: open ? 'expo.out' : 'power3.inOut',
          })
        return
      }

      gsap.set(el, { clearProps: 'width' })
      if (!overlayBelow) {
        gsap.set(el, { clearProps: 'x,opacity,visibility,transform' })
        return
      }
      const vars = { xPercent: open ? 0 : from * 104, autoAlpha: open ? 1 : 0 }
      if (instant) gsap.set(el, vars)
      else
        gsap.to(el, {
          ...vars,
          duration: open ? 0.5 : 0.32,
          ease: open ? 'power4.out' : 'power2.in',
        })
    }

    apply(!firstRun.current)
    firstRun.current = false

    const onChange = () => apply(false)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [ref, open, pushQuery, overlayBelow, from])
}
