import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { gsap, SplitText, ScrollTrigger, Flip } from './gsap'

/**
 * 全站动效的唯一入口。
 *
 * 分工原则（避免"到处都在动"造成的廉价感）：
 * - GSAP：结构性动效 —— 页面入场、面板位移、提交后的转场、列表批量错峰
 * - CSS ：微交互 —— hover / focus / 颜色过渡（合成层友好，不掉帧）
 *
 * 节奏只有三档（与 styles/motion.css 的 CSS 变量一一对应）：
 *   fast 160ms / base 240ms / slow 420ms
 *
 * 所有函数都必须尊重 `prefers-reduced-motion` 与低性能降级：无障碍优先于炫技。
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 低性能设备判定：内存 ≤ 4GB 或核心数 ≤ 4，视为"不要给氛围动画"。
 * 只在首帧算一次并缓存——每次读 navigator 虽不贵，但这里会被多次调用。
 */
let liteCache: boolean | null = null
export function isLowPowerDevice(): boolean {
  if (liteCache !== null) return liteCache
  if (typeof navigator === 'undefined') return (liteCache = false)
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  const cores = navigator.hardwareConcurrency ?? 8
  const saveData =
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ?? false
  liteCache = saveData || memory <= 4 || cores <= 4
  return liteCache
}

/** 是否应该跳过动效（减弱动效 / 低性能 / 省流量）。 */
export function shouldReduceMotion(): boolean {
  return prefersReducedMotion() || isLowPowerDevice()
}

/**
 * 给 <html> 挂性能标记：CSS 里据此关掉持续氛围动画。
 * 在 App 启动时调用一次，返回清理函数。
 */
export function installMotionProfile() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (prefersReducedMotion()) root.classList.add('cs-reduced')
  if (isLowPowerDevice()) root.classList.add('cs-lite')
  // 用户中途改了系统「减弱动效」设置也要跟着变
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  if (!mq) return
  const onChange = (event: MediaQueryListEvent) => {
    root.classList.toggle('cs-reduced', event.matches)
  }
  mq.addEventListener?.('change', onChange)
  return () => mq.removeEventListener?.('change', onChange)
}

export const EASE = {
  out: 'power3.out',
  inOut: 'power3.inOut',
  spring: 'back.out(1.7)',
} as const

export const DURATION = {
  fast: 0.16,
  base: 0.24,
  slow: 0.42,
  slower: 0.62,
} as const

interface RevealOptions {
  /** 只动这些子元素（缺省 = 直接子节点） */
  selector?: string
  y?: number
  x?: number
  scale?: number
  stagger?: number
  delay?: number
  duration?: number
  /** 入场完成后是否清除内联样式（默认 true，避免残留 transform 影响 fixed 子元素） */
  clear?: boolean
}

function collect(root: HTMLElement, selector?: string): HTMLElement[] {
  const list = selector
    ? Array.from(root.querySelectorAll<HTMLElement>(selector))
    : (Array.from(root.children) as HTMLElement[])
  return list.filter((el) => !el.hasAttribute('data-no-reveal'))
}

/**
 * 入场动效：容器内元素自下而上错峰浮现。
 * 用 useLayoutEffect 而不是 useEffect —— 在浏览器绘制前就把初始态写好，避免"闪一下"。
 */
export function useReveal<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: RevealOptions = {}
) {
  const {
    selector,
    y = 18,
    x = 0,
    scale = 1,
    stagger = 0.06,
    delay = 0,
    duration = 0.68,
    clear = true,
  } = options

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const targets = collect(root, selector)
    if (targets.length === 0) return
    if (shouldReduceMotion()) return

    const ctx = gsap.context(() => {
      gsap.from(targets, {
        y,
        x,
        scale,
        opacity: 0,
        duration,
        delay,
        stagger,
        ease: EASE.out,
        clearProps: clear ? 'transform,opacity' : undefined,
        overwrite: 'auto',
      })
    }, root)
    return () => ctx.revert()
    // 选项都是原始值，依赖数组保持稳定即可
  }, [ref, selector, y, x, scale, stagger, delay, duration, clear])
}

/**
 * 列表动效：数据变化（依赖值改变）时让新一批子元素依次浮现。
 * 与 useReveal 的区别是它会在**每次依赖变化**时重放，用于会话列表 / 作品网格。
 */
export function useListReveal<T extends HTMLElement>(
  ref: RefObject<T | null>,
  dep: unknown,
  options: RevealOptions = {}
) {
  const { selector, y = 10, scale = 1, stagger = 0.035, duration = 0.45, delay = 0 } = options

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const targets = collect(root, selector)
    if (targets.length === 0 || shouldReduceMotion()) return
    const ctx = gsap.context(() => {
      gsap.fromTo(
        targets,
        { y, scale, opacity: 0 },
        {
          y: 0,
          scale: 1,
          opacity: 1,
          duration,
          delay,
          stagger,
          ease: EASE.out,
          clearProps: 'transform,opacity',
          overwrite: 'auto',
        }
      )
    }, root)
    return () => ctx.revert()
  }, [ref, dep, selector, y, scale, stagger, duration, delay])
}

/** 按压反馈：提交类按钮点下去的一瞬间要有"被接住"的手感。 */
export function pressFeedback(el: HTMLElement | null) {
  if (!el || shouldReduceMotion()) return
  gsap.fromTo(
    el,
    { scale: 1 },
    { scale: 0.94, duration: 0.1, ease: 'power2.out', yoyo: true, repeat: 1 }
  )
}

/**
 * 元素消失动效：先播完再真正卸载。
 *
 * 返回 Promise，调用方 `await` 后再 setState 移除 —— 否则 React 会立刻把
 * 节点从 DOM 摘掉，再漂亮的过渡也来不及播放。
 */
export function exitElement(el: HTMLElement | null, direction: 'up' | 'down' = 'down') {
  if (!el || shouldReduceMotion()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    gsap.to(el, {
      opacity: 0,
      y: direction === 'down' ? 8 : -8,
      scale: 0.98,
      duration: DURATION.fast,
      ease: 'power2.in',
      onComplete: resolve,
    })
  })
}

/**
 * 数值滚动（额度、计数）。用 GSAP 的 onUpdate 写文本，避免 React 每帧重渲染。
 */
export function tweenNumber(
  el: HTMLElement | null,
  from: number,
  to: number,
  format: (value: number) => string = (v) => String(Math.round(v))
) {
  if (!el) return
  if (shouldReduceMotion() || from === to) {
    el.textContent = format(to)
    return
  }
  const state = { value: from }
  gsap.killTweensOf(state)
  gsap.to(state, {
    value: to,
    duration: DURATION.slow,
    ease: EASE.out,
    onUpdate: () => {
      el.textContent = format(state.value)
    },
  })
}

/**
 * 吸附磁力：指针在父容器内移动时，元素朝指针方向轻移。
 * 用于首页发送键等"想让人多点一下"的目标。
 */
export function useMagnetic<T extends HTMLElement>(ref: RefObject<T | null>, strength = 7) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || shouldReduceMotion()) return
    const xTo = gsap.quickTo(el, 'x', { duration: 0.45, ease: 'power2.out' })
    const yTo = gsap.quickTo(el, 'y', { duration: 0.45, ease: 'power2.out' })

    const parent = el.parentElement ?? el
    const onMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const relX = (event.clientX - (rect.left + rect.width / 2)) / rect.width
      const relY = (event.clientY - (rect.top + rect.height / 2)) / rect.height
      xTo(relX * strength)
      yTo(relY * strength * 0.7)
    }
    const onLeave = () => {
      gsap.to(el, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.5)' })
    }
    parent.addEventListener('pointermove', onMove)
    parent.addEventListener('pointerleave', onLeave)
    return () => {
      parent.removeEventListener('pointermove', onMove)
      parent.removeEventListener('pointerleave', onLeave)
    }
  }, [ref, strength])
}

/* -------------------------------------------------------------------------- */
/* 主题切换（已迁移）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 主题切换：**已迁移**到 `lib/theme-transition.ts` 的 `switchThemeWithRipple`。
 *
 * 原来的 `withThemeFade`（给 <html> 挂 320ms 全局颜色 transition）已停用并删除：
 * 整页所有像素同时转向，眼睛找不到变化方向，观感是"闪了一下"。
 * 新方案以触发按钮为圆心做墨滴扩散，且扩散只改一层覆盖（或 View Transition
 * 快照），不再给全站元素挂 transition。
 */

/* -------------------------------------------------------------------------- */
/* 首页 → 工作室的转场                                                        */
/* -------------------------------------------------------------------------- */

let curtain: HTMLDivElement | null = null

function getCurtain(): HTMLDivElement {
  if (curtain && document.body.contains(curtain)) return curtain
  const el = document.createElement('div')
  el.setAttribute('data-cs-curtain', '')
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:4000',
    'pointer-events:none',
    'opacity:0',
    'background:#0d0c08',
    'will-change:clip-path,opacity',
  ].join(';')

  const glow = document.createElement('div')
  glow.style.cssText = [
    'position:absolute',
    'inset:0',
    'background:radial-gradient(720px 520px at 50% 44%, rgba(205,245,100,0.20), transparent 72%)',
  ].join(';')
  el.appendChild(glow)

  document.body.appendChild(el)
  curtain = el
  return el
}

/**
 * 「进入工作室」的镜头转场。
 *
 * 用 clip-path 圆形扩散而不是淡入淡出：扩散的原点来自用户点击的那颗按钮，
 * 视觉上像镜头从指尖推开一扇门，比整屏渐变更有因果感、也更贵。
 * 转场期间不拦截点击（pointer-events:none），避免用户以为页面卡死。
 */
export async function enterStudio(
  origin: { x: number; y: number } | null,
  go: () => void
): Promise<void> {
  if (shouldReduceMotion()) {
    go()
    return
  }
  const el = getCurtain()
  const x = origin?.x ?? window.innerWidth / 2
  const y = origin?.y ?? window.innerHeight * 0.55
  const radius =
    Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) * 1.08

  gsap.killTweensOf(el)
  gsap.set(el, { opacity: 1, clipPath: `circle(0px at ${x}px ${y}px)` })

  await new Promise<void>((resolve) => {
    gsap.to(el, {
      clipPath: `circle(${radius}px at ${x}px ${y}px)`,
      duration: 0.58,
      ease: EASE.inOut,
      onComplete: resolve,
    })
  })

  go()

  // 目标页首帧就位后再揭开：先让工作室的入场动画起步，帘子再淡出，
  // 这样用户看到的是「新页面已经在动」，而不是「先白屏再出现」。
  requestAnimationFrame(() => {
    gsap.to(el, {
      opacity: 0,
      duration: 0.52,
      delay: 0.06,
      ease: 'power2.out',
      onComplete: () => gsap.set(el, { clipPath: 'circle(0px at 50% 50%)' }),
    })
  })
}

/* -------------------------------------------------------------------------- */
/* 路由转场                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 路由切换的进场动画。
 *
 * 不做「旧页滑出」：那需要在离开前把旧页面定格，等于接管整个路由生命周期，
 * 一旦某个页面数据加载慢，用户会盯着一个僵住的页面。只做新页轻上浮——
 * 120ms 内就能看到响应，这才是"流畅"的体感来源。
 */
export function useRouteTransition(
  containerRef: RefObject<HTMLElement | null>,
  routeKey: string,
  options: { y?: number; duration?: number } = {}
) {
  const { y = 10, duration = 0.42 } = options
  const first = useRef(true)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 首次加载用更快的淡入（用户在等首屏，不该再等动画）
    const isFirst = first.current
    first.current = false
    if (shouldReduceMotion()) return

    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { opacity: 0, y: isFirst ? 0 : y },
        {
          opacity: 1,
          y: 0,
          duration: isFirst ? 0.3 : duration,
          ease: EASE.out,
          clearProps: 'transform,opacity',
          overwrite: 'auto',
        }
      )
    })
    return () => ctx.revert()
  }, [containerRef, routeKey, y, duration])
}

/** 页面不可见时暂停氛围动画（后台标签页不该继续烧 GPU）。 */
export function useVisibilityPause(onHidden: (hidden: boolean) => void) {
  useEffect(() => {
    const handler = () => onHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [onHidden])
}

/* -------------------------------------------------------------------------- */
/* 高级动效（基于 GSAP 官方插件：SplitText / ScrollTrigger / Flip）            */
/* -------------------------------------------------------------------------- */

/**
 * 标题逐字入场（SplitText）。
 *
 * 中文按字拆、英文按词拆——SplitText 的 `chars` 模式对中文正好是"逐字"。
 * 每个字从遮罩里升起（y:110% + 父级 overflow:hidden），比重影/模糊更干净。
 *
 * `mask: true` 会给每行套一个 overflow:hidden 容器，动画结束后必须 revert，
 * 否则残留的容器会切断字形的行高（比如 g、y 的下伸部分）。
 */
export function splitReveal(
  target: HTMLElement | null,
  options: { stagger?: number; delay?: number; duration?: number } = {}
) {
  if (!target || shouldReduceMotion()) return () => undefined
  const { stagger = 0.045, delay = 0.1, duration = 0.72 } = options

  const split = new SplitText(target, { type: 'chars,words', mask: 'chars' })
  const tween = gsap.from(split.chars, {
    yPercent: 115,
    rotate: 3,
    opacity: 0,
    duration,
    delay,
    stagger,
    ease: 'csPaper',
    onComplete: () => {
      // 动画结束立刻还原：保留 SplitText 的 DOM 会让文本无法正常选中/换行
      split.revert()
    },
  })
  return () => {
    tween.kill()
    split.revert()
  }
}

/**
 * 标题逐字入场（React 版）。挂在带 `data-split` 的元素上即可。
 */
export function useSplitReveal<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: unknown[] = [],
  options: { stagger?: number; delay?: number; duration?: number } = {}
) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return splitReveal(el, options)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/**
 * 滚动揭示（ScrollTrigger）：元素进入视口时上浮淡入。
 *
 * `once: true` —— 回滚时不再重播。列表页反复上下滚动还一直闪，是很廉价的观感。
 */
export function useScrollReveal<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: { selector?: string; y?: number; stagger?: number; start?: string } = {}
) {
  const { selector, y = 24, stagger = 0.05, start = 'top 88%' } = options

  useLayoutEffect(() => {
    const root = ref.current
    if (!root || shouldReduceMotion()) return
    const targets = selector
      ? Array.from(root.querySelectorAll<HTMLElement>(selector))
      : (Array.from(root.children) as HTMLElement[])
    if (targets.length === 0) return

    const ctx = gsap.context(() => {
      gsap.set(targets, { opacity: 0, y })
      ScrollTrigger.batch(targets, {
        start,
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            opacity: 1,
            y: 0,
            duration: 0.6,
            stagger,
            ease: 'csPaper',
            overwrite: true,
          }),
      })
    }, root)

    return () => ctx.revert()
  }, [ref, selector, y, stagger, start])
}

/**
 * 布局变化动画（Flip）。
 *
 * 列表增删、标签切换、面板折叠改变布局时，用 Flip 记录前后位置再补间，
 * 元素会"飞"到新位置而不是瞬间跳过去。返回一个 `play(fn)` 包装器。
 */
export function flipLayout(container: HTMLElement | null) {
  if (!container || shouldReduceMotion()) {
    return <T,>(apply: () => T): T => apply()
  }
  const targets = Array.from(container.children) as HTMLElement[]
  const state = Flip.getState(targets, { props: 'opacity,backgroundColor' })
  const apply = <T,>(fn: () => T): T => {
    const result = fn()
    Flip.from(state, {
      duration: 0.42,
      ease: 'csSnap',
      absolute: false,
      stagger: 0.015,
      onEnter: (els) =>
        gsap.fromTo(
          els,
          { opacity: 0, scale: 0.92, y: -8 },
          { opacity: 1, scale: 1, y: 0, duration: 0.42, ease: 'csPaper' }
        ),
      onLeave: (els) =>
        gsap.to(els, { opacity: 0, scale: 0.94, duration: 0.2, ease: 'power2.in' }),
    })
    return result
  }
  return apply
}

/**
 * 光标跟随的光斑（首页 / 空态）。
 *
 * 用 quickTo 而不是每帧 setState：指针事件频率可达 120Hz，
 * 走 React 状态会让整棵树每帧重渲染，必然卡。
 */
export function useSpotlight(ref: RefObject<HTMLElement | null>, size = 420) {
  useLayoutEffect(() => {
    const host = ref.current
    if (!host || shouldReduceMotion()) return

    const spot = document.createElement('div')
    spot.setAttribute('aria-hidden', '')
    spot.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'pointer-events:none',
      'z-index:0',
      `width:${size}px`,
      `height:${size}px`,
      'border-radius:9999px',
      'opacity:0',
      'transform:translate(-50%,-50%)',
      'background:radial-gradient(circle, color-mix(in srgb, var(--color-accent) 26%, transparent), transparent 68%)',
      'filter:blur(28px)',
      'will-change:transform,opacity',
    ].join(';')
    host.appendChild(spot)

    const xTo = gsap.quickTo(spot, 'x', { duration: 0.6, ease: 'power3.out' })
    const yTo = gsap.quickTo(spot, 'y', { duration: 0.6, ease: 'power3.out' })

    const onMove = (event: PointerEvent) => {
      xTo(event.clientX)
      yTo(event.clientY)
    }
    const onEnter = () => gsap.to(spot, { opacity: 1, duration: 0.4 })
    const onLeave = () => gsap.to(spot, { opacity: 0, duration: 0.3 })

    window.addEventListener('pointermove', onMove, { passive: true })
    host.addEventListener('pointerenter', onEnter)
    host.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerenter', onEnter)
      host.removeEventListener('pointerleave', onLeave)
      spot.remove()
    }
  }, [ref, size])
}

/**
 * 层级式入场：一组元素同时从不同方向聚拢（输入框 + 建议词 + 价值点）。
 * 比统一上浮更有"组装感"，适合首屏。
 */
export function assemblyReveal(root: HTMLElement | null, selector = '[data-assemble]') {
  if (!root || shouldReduceMotion()) return
  const items = Array.from(root.querySelectorAll<HTMLElement>(selector))
  if (items.length === 0) return
  const tl = gsap.timeline({ defaults: { ease: 'csPaper', duration: 0.7 } })
  items.forEach((item, index) => {
    const from = item.dataset.assemble || 'up'
    const vars: gsap.TweenVars = { opacity: 0 }
    if (from === 'up') vars.y = 26
    if (from === 'down') vars.y = -20
    if (from === 'left') vars.x = -28
    if (from === 'right') vars.x = 28
    if (from === 'scale') vars.scale = 0.94
    tl.from(item, vars, index * 0.07)
  })
  return () => tl.kill()
}


/* -------------------------------------------------------------------------- */
/* 跨路由「原地接管」转场（追加导出，不改动上面任何函数）                      */
/* -------------------------------------------------------------------------- */

/** View Transition API 的最小类型（lib.dom 未必声明）。 */
interface ViewTransitionLike {
  ready: Promise<void>
  finished: Promise<void>
  skipTransition?: () => void
}

/**
 * 用 View Transition 把一次路由跳转变成「原地淡出 → 淡入」。
 *
 * 为什么需要它：`useRouteTransition` 只处理"新页进场"，旧页是瞬间消失的——
 * 从首页点「进入工作室」时，如果正好没有 `enterStudio` 的帘子（例如从侧栏、
 * 从通知跳转），用户会看到旧页直接换成新页，中间没有任何过渡。
 *
 * 做法：把 `navigate()` 包进 `startViewTransition`。浏览器给旧帧拍快照、
 * 执行跳转、再给新帧拍快照，两帧之间由 CSS（motion.css 里的
 * `html[data-cs-page-vt]` 规则）交叉淡入淡出 + 极轻的位移。
 *
 * 不支持 View Transition 的浏览器直接执行 `go()`——**绝不**为了动画把跳转
 * 推迟到定时器里，那样一旦动画被跳过，用户会以为点击失灵。
 *
 * 与 `enterStudio` 的分工：enterStudio 是"整段镜头推进"，用于首页主入口；
 * 这里只是"换页时别硬切"，两者不要同时用（会叠两层帘子）。
 */
export function navigateWithTransition(go: () => void | Promise<void>) {
  if (typeof document === 'undefined' || shouldReduceMotion()) {
    void go()
    return
  }
  const doc = document as Document & {
    startViewTransition?: (cb: () => void | Promise<void>) => ViewTransitionLike
  }
  if (typeof doc.startViewTransition !== 'function') {
    void go()
    return
  }

  const root = document.documentElement
  root.setAttribute('data-cs-page-vt', '')
  const vt = doc.startViewTransition(() => go())
  // 无论成功失败都要摘标记：留着会让后续每次导航都套一层本该一次性的动画
  const done = () => root.removeAttribute('data-cs-page-vt')
  vt.finished.then(done, done)
}

/**
 * 入场层次：给一个"第几层"换算成 useReveal 的 delay / y。
 *
 * 工作台三栏不该"齐步走"：左栏先落（用户先确认"我在哪个项目"），
 * 画布随后（主舞台），对话面板最后（它的内容本来就要等数据）。
 * 越靠后的层位移越小——远处的层该"淡出来"，近处的层才"落下来"，
 * 这样纵深感来自位移差，而不是把三块都推一遍。
 */
export function panelLadder(index: number, step = 0.085) {
  return { delay: index * step, y: Math.max(8, 18 - index * 5) }
}
