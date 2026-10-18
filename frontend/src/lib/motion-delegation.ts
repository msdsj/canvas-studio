import { gsap } from './gsap'
import { DURATION, shouldReduceMotion } from './motion'

/**
 * 声明式动效：全局事件委托。
 *
 * 为什么不做成 hook：全站有上百个按钮 / 卡片 / 列表项，逐个 useEffect 挂监听
 * 既污染组件（每处三五行样板），又会在条件渲染下反复解绑重绑（StrictMode 双挂载
 * 时还会叠两份）。改成**在 document 上装一次、按 data 属性分发**：
 *
 *   <button data-motion="press">          // 按下 0.97，松开弹回
 *   <button data-motion="lift">           // hover 微抬（图标按钮）
 *   <li data-motion="row">                // hover 高光从左侧扫过
 *   <div data-motion-group>               // 分段控件容器
 *     <span data-motion-slider />         //   它的滑块（绝对定位，JS 摆位）
 *     <button data-motion="segment" />    //   每个选项
 *   </div>
 *
 * 一次性入场（不靠委托，组件显式调用）：staggerIn / popIcon。
 *
 * 硬约束：
 * - 只碰 transform / opacity；不做持续动画，全部是"按一下就结束"的微交互
 * - `shouldReduceMotion()` 时整体不安装，等于零开销
 * - 不做 data-motion="press" 与 Tailwind `active:scale-*` 同时出现的重复反馈：
 *   同一元素只允许一处声明缩放，否则两个来源互相覆盖，按压会"抖两下"
 *
 * 安装/卸载幂等：StrictMode 下 useEffect 会执行两次（setup → cleanup → setup），
 * 所以 cleanup 必须能干净撤掉上一份监听——所有监听都挂在同一个 AbortController 上。
 */

const PRESS_SCALE = 0.97
/** 指针移动超过这个距离就不算"按下"，避免拖选文本 / 滚动时误触 */
const TAP_SLOP = 10

let installed = false
let controller: AbortController | null = null
/**
 * cleanup 幂等标记：StrictMode 下同一个组件实例的 cleanup 可能被调用两次
 * （React 19 StrictMode 会重复执行 effect 的销毁回调），第二次若再 abort，
 * 会把"重新安装"的那一份监听一起拆掉——表现为页面刚打开就有 css 类又被摘掉。
 */
let disposed = false

export function installMotionDelegation() {
  if (typeof document === 'undefined' || installed) return () => undefined
  if (shouldReduceMotion()) return () => undefined

  installed = true
  disposed = false
  document.documentElement.classList.add('cs-press-live')
  controller = new AbortController()
  const { signal } = controller

  /** 按下时命中的元素（释放/取消时靠它复位，不依赖那时的事件目标） */
  let downAt: { x: number; y: number; el: HTMLElement } | null = null

  // ---- 1. 按压 ------------------------------------------------------------
  // 用 pointerdown 而不是 click：按下就要有回应，等 click 已经晚了 100ms，
  // 而"手感"恰恰全在这 100ms 里。
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = pick(event.target, 'press')
      if (!target || event.button !== 0) return
      downAt = { x: event.clientX, y: event.clientY, el: target }
      gsap.killTweensOf(target)
      gsap.to(target, {
        scale: PRESS_SCALE,
        duration: 0.12,
        ease: 'power2.out',
        overwrite: 'auto',
      })
    },
    { signal, passive: true }
  )

  const release = (event: PointerEvent) => {
    // 只有确实按过（downAt 存在）才回弹：单纯滑过按钮不该有动作。
    // 目标取按下那一刻的元素——释放时指针可能已经在文字 / icon 上，closest 还能找到它，
    // 但若用户拖出按钮，事件目标就变了，靠记录下来的 el 才可靠。
    if (!downAt) return
    const target = downAt.el
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > TAP_SLOP
    downAt = null
    if (moved) {
      gsap.to(target, { scale: 1, duration: 0.2, ease: 'power2.out', clearProps: 'scale' })
      return
    }
    // 释放时用 back.out 轻微过冲：像被手接住后回弹，而不是生硬地回到 1
    gsap.to(target, { scale: 1, duration: 0.34, ease: 'back.out(2.4)', clearProps: 'scale' })
  }
  document.addEventListener('pointerup', release, { signal, passive: true })
  // 拖拽滚动 / 系统手势打断时 pointerup 不会来，用 cancel + scroll 兜底复位
  const reset = () => {
    const target = downAt?.el ?? null
    downAt = null
    if (target) gsap.to(target, { scale: 1, duration: 0.2, ease: 'power2.out', clearProps: 'scale' })
  }
  document.addEventListener('pointercancel', reset, { signal, passive: true })
  document.addEventListener('scroll', reset, { signal, passive: true, capture: true })

  // ---- 2. 图标按钮微抬 ----------------------------------------------------
  // 用 pointerover / pointerout（会冒泡）在 document 上代理，而不是 mouseenter：
  // 后者不冒泡，只能在捕获阶段取，和 event.target 的判定容易互相打架。
  // 进出判断统一成「relatedTarget 是否仍在同一个宿主内」。
  document.addEventListener(
    'pointerover',
    (event) => {
      const host = pick(event.target, 'lift')
      if (!host || host.contains(event.relatedTarget as Node | null)) return
      gsap.to(host, { y: -1.5, duration: 0.2, ease: 'power2.out', overwrite: 'auto' })
    },
    { signal, passive: true }
  )
  document.addEventListener(
    'pointerout',
    (event) => {
      const host = pick(event.target, 'lift')
      if (!host || host.contains(event.relatedTarget as Node | null)) return
      gsap.to(host, { y: 0, duration: 0.26, ease: 'power2.out', overwrite: 'auto', clearProps: 'y' })
    },
    { signal, passive: true }
  )

  // ---- 3. 列表行高光扫过 --------------------------------------------------
  // 高光是一个绝对定位的子元素（由 CSS 的 [data-motion="row"] 提供层叠上下文），
  // 这里只补间它的 xPercent。不用 background-position（触发重绘），
  // 也不用 backdrop-filter（每帧采样背景，列表一长就掉帧）。
  document.addEventListener(
    'pointerover',
    (event) => {
      const row = pick(event.target, 'row')
      if (!row || row.contains(event.relatedTarget as Node | null)) return
      const sheen = row.querySelector<HTMLElement>('[data-motion-sheen]')
      if (!sheen) return
      // 先把 xPercent 写回起点再开始：GSAP 对 xPercent 同一元素反复 fromTo 时，
      // 若上一次还没被 kill 干净，会以当前值作起点，第二次扫过就"原地不动"。
      gsap.killTweensOf(sheen)
      gsap.set(sheen, { xPercent: -120 })
      gsap.fromTo(
        sheen,
        { xPercent: -120, opacity: 1 },
        { xPercent: 220, opacity: 1, duration: 0.62, ease: 'power2.out' }
      )
    },
    { signal, passive: true }
  )

  // ---- 4. 分段控件滑块 -----------------------------------------------------
  // 点击带 data-motion="segment" 的按钮后，同组内的 [data-motion-slider] 落到
  // 目标按钮的位置，从旧 rect 补间过去（跳 → 滑）。
  // 这里没用 Flip 插件：滑块的宽度本身也在变（不同标签文字长短不同），
  // Flip 默认按 scale 变形，文字会被拉扁；直接补间 x/y/width 更可控。
  // 落点直接取目标按钮的 rect，不依赖父级的 padding / gap 具体数值，
  // 样式怎么改都不会错位。
  document.addEventListener(
    'click',
    (event) => {
      const btn = pick(event.target, 'segment')
      const group = btn?.closest<HTMLElement>('[data-motion-group]')
      const slider = group?.querySelector<HTMLElement>('[data-motion-slider]')
      if (!btn || !group || !slider) return
      const before = slider.getBoundingClientRect()
      // 同步把滑块摆到新位置，再从旧 rect 补间回来
      placeSlider(slider, btn, group)
      const after = slider.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      if (dx === 0 && dy === 0) return
      gsap.fromTo(
        slider,
        { x: dx, y: dy, width: before.width, height: before.height },
        {
          x: 0,
          y: 0,
          width: after.width,
          height: after.height,
          duration: 0.36,
          ease: 'csSnap',
          overwrite: 'auto',
        }
      )
    },
    { signal, passive: true }
  )

  // 首帧与尺寸变化时把滑块静默对齐到当前选中项（否则第一次点击前它停在左上角）
  const syncAll = () => {
    document.querySelectorAll<HTMLElement>('[data-motion-group]').forEach((group) => {
      const slider = group.querySelector<HTMLElement>('[data-motion-slider]')
      const active = group.querySelector<HTMLElement>(
        '[data-motion="segment"][aria-pressed="true"], [data-motion="segment"][data-state="active"], [data-motion="segment"][aria-selected="true"]'
      )
      if (!slider || !active) return
      gsap.killTweensOf(slider)
      placeSlider(slider, active, group)
    })
  }
  requestAnimationFrame(syncAll)
  // 窗口尺寸变化会让百分比宽度错位：重新对齐（不做动画，避免 resize 时抖）
  window.addEventListener('resize', syncAll, { signal, passive: true })

  return () => {
    // 只撤一次：第二次调用若继续 abort，会把"重新安装"的那一份也拆掉
    if (disposed) return
    disposed = true
    controller?.abort()
    controller = null
    installed = false
    document.documentElement.classList.remove('cs-press-live')
  }
}

/**
 * 把滑块摆到目标按钮的位置。
 *
 * 用绝对定位 + x/y 平移（transform）+ 显式宽高：left/top 恒为 0，
 * 位置只靠 transform 表达，后续补间也只在这个维度上动，永远不会触发布局。
 */
function placeSlider(slider: HTMLElement, btn: HTMLElement, group: HTMLElement) {
  const g = group.getBoundingClientRect()
  const b = btn.getBoundingClientRect()
  gsap.set(slider, {
    position: 'absolute',
    left: 0,
    top: 0,
    margin: 0,
    width: b.width,
    height: b.height,
    x: b.left - g.left,
    y: b.top - g.top,
  })
}

/**
 * 从事件目标向上找最近的、带指定 data-motion 值的元素。
 *
 * 用 closest 会穿过组件边界——这正是不逐个组件挂监听的原因：
 * 按钮里嵌 icon（svg 的 path）、文字 span，事件目标永远是最内层那个节点。
 */
function pick(target: EventTarget | null, value: string): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const el = target.closest<HTMLElement>(`[data-motion="${value}"]`)
  if (!el) return null
  if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return null
  return el
}

/* -------------------------------------------------------------------------- */
/* 入场 / 一次性反馈（与委托事件无关，供组件显式调用）                        */
/* -------------------------------------------------------------------------- */

/**
 * 子项依次浮现。给容器加 `data-motion="stagger"`，子项加 `data-motion-item`。
 * 与 useReveal 的区别：不依赖 React 引用，纯 DOM；适合弹层内容、动态插入的区块。
 */
export function staggerIn(root: HTMLElement | null, selector = '[data-motion-item]', delay = 0) {
  if (!root || shouldReduceMotion()) return
  const items = Array.from(root.querySelectorAll<HTMLElement>(selector))
  if (items.length === 0) return
  gsap.from(items, {
    opacity: 0,
    y: 8,
    duration: DURATION.slow,
    delay,
    stagger: 0.04,
    ease: 'csPaper',
    clearProps: 'transform,opacity',
    overwrite: 'auto',
  })
}

/**
 * Toast 图标入场：成功 / 失败用 csSnap 从 0.4 弹到 1.06 再落回 1。
 * 图标是"结果"的符号，比文字晚一拍出现，读起来的顺序是「卡片 → 图标 → 内容」。
 */
export function popIcon(el: HTMLElement | null) {
  if (!el || shouldReduceMotion()) return
  gsap.killTweensOf(el)
  gsap.fromTo(
    el,
    { scale: 0.4, opacity: 0, rotate: -12 },
    { scale: 1, opacity: 1, rotate: 0, duration: 0.44, ease: 'csSnap', delay: 0.06 }
  )
}
