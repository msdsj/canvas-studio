import { gsap } from './gsap'
import { shouldReduceMotion } from './motion'

/**
 * 主题切换的「墨滴扩散」。
 *
 * 背景：早期做法是给 <html> 挂 320ms 全局颜色 transition，一次性把整页颜色
 * 从 A 渐变到 B。问题是「整页同时变」——所有像素一起转向，眼睛找不到变化的方向，
 * 观感就是"闪了一下"，还被误认为卡顿。
 *
 * 现在改成：以主题按钮为圆心，**新主题像一滴墨从按钮位置向四周洇开**。
 * 有原点就有因果：用户点哪里，变化就从哪里开始，机制感立刻不同。
 *
 * 两条实现路径：
 *  1. View Transition API（Chrome 111+ / Safari 18+）
 *     浏览器给旧帧拍快照，新帧按 `::view-transition-new(root)` 的 clip-path
 *     逐帧揭开。整个过程在合成器里完成，没有重绘撕裂。
 *  2. 降级覆盖层（Firefox 等）
 *     在 body 上铺一层纯色（目标主题的 --color-bg），用 GSAP 补间它的
 *     clip-path: circle()，收尾时整层淡出抹掉圆边。
 *
 * 为什么读 --color-bg 而不硬编码：扩散的"墨"必须就是目标主题的纸色，
 * 否则接缝处会有一帧色差。token 变了这里自动跟着变。
 *
 * 补间为什么用 gsap.fromTo 一条到位而不是分两段：分两段（先 set 再 to）在
 * 补间创建前会有一帧 0 半径的空档，快速连点时容易叠出两层。
 */

/** 扩散层 z-index：高于应用内容与普通弹层。 */
const RIPPLE_Z = 9998
/** 默认节奏 580ms：比路由转场（420ms）长一点，世界观级别的变化值得多等一瞬。 */
const DEFAULT_DURATION = 0.58
/** 青柠光圈半径相对主圆的比例。 */
const GLOW_RATIO = 0.82

/** View Transition API 的最小类型（lib.dom 未必声明，避免依赖 TS 版本）。 */
interface ViewTransitionLike {
  ready: Promise<void>
  finished: Promise<void>
  updateCallbackDone: Promise<void>
  skipTransition?: () => void
}
type DocumentWithVT = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike
}

export interface RippleOptions {
  /** 目标主题。用于推进降级覆盖层时精确读目标纸色。 */
  theme?: 'light' | 'dark'
  /** 扩散时长（秒）。默认 0.58。 */
  duration?: number
  /** 强制走降级路径（调试用）。 */
  forceFallback?: boolean
}

/* -------------------------------------------------------------------------- */
/* 可重入状态                                                                 */
/* -------------------------------------------------------------------------- */

let activeTween: gsap.core.Tween | null = null
let activeLayer: HTMLDivElement | null = null
let activeVT: ViewTransitionLike | null = null
let overlayTimer = 0
/** 在途的 Promise 结算器：新一轮开始前必须全部结算，否则调用方的 await 会永远挂住 */
const pendingResolvers = new Set<() => void>()

/** 登记一次在途的 Promise，返回它的结算函数（幂等）。 */
function track(settle: () => void) {
  pendingResolvers.add(settle)
  return () => {
    if (!pendingResolvers.delete(settle)) return
    settle()
  }
}

/**
 * 收掉上一轮的一切：补间、覆盖层、快照、定时器。必须幂等。
 *
 * 关键是结算 `pendingResolvers`：被中断的那一轮 Promise **必须 resolve**，
 * 否则 `await switchThemeWithRipple(...)` 的调用方会永远挂住——
 * 快速连点时第二次点击会把第一次的 Promise 悬在半空。
 */
function teardown() {
  if (overlayTimer) {
    window.clearTimeout(overlayTimer)
    overlayTimer = 0
  }
  if (activeVT?.skipTransition) {
    try {
      activeVT.skipTransition()
    } catch {
      /* 已结束的 transition 再 skip 会抛错，忽略 */
    }
  }
  activeVT = null
  if (activeTween) {
    activeTween.kill()
    activeTween = null
  }
  if (activeLayer) {
    gsap.killTweensOf(activeLayer)
    activeLayer.remove()
    activeLayer = null
  }
  // 在途的每一轮都必须结算：漏掉一个，调用方的 await 就永远挂住
  const resolvers = Array.from(pendingResolvers)
  pendingResolvers.clear()
  resolvers.forEach((settle) => settle())
  clearVTVars()
}

/* -------------------------------------------------------------------------- */
/* 几何                                                                       */
/* -------------------------------------------------------------------------- */

interface Origin {
  x: number
  y: number
  /** 到视口四角的最大距离 ×1.08——保证圆完全盖住屏幕，包括圆角外溢。 */
  radius: number
}

function resolveOrigin(originEl: HTMLElement | null): Origin {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = vw / 2
  let y = vh / 2

  if (originEl) {
    const rect = originEl.getBoundingClientRect()
    // 元素被卸载 / 尚未布局时宽高为 0：退回视口中心，别把原点算到左上角
    if (rect.width > 0 && rect.height > 0) {
      x = rect.left + rect.width / 2
      y = rect.top + rect.height / 2
    }
  }

  return { x, y, radius: Math.hypot(Math.max(x, vw - x), Math.max(y, vh - y)) * 1.08 }
}

/* -------------------------------------------------------------------------- */
/* 取色                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 读**目标主题**的 `--color-bg`。
 *
 * 在不可见探针上临时把 `data-theme` 切到目标值再读计算值，读完立刻还原。
 * `getComputedStyle` 是同步的，这一来一回不会产生可见闪烁。
 * 直接给探针写 `var(--color-bg)` 不够——变量在 <html> 上按当前主题解析。
 */
function readThemeBg(theme: 'light' | 'dark'): string {
  const root = document.documentElement
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:0;height:0;visibility:hidden;pointer-events:none'
  document.body.appendChild(probe)

  const previous = root.getAttribute('data-theme')
  root.setAttribute('data-theme', theme)
  const bg = getComputedStyle(probe).getPropertyValue('--color-bg').trim()
  if (previous) root.setAttribute('data-theme', previous)
  else root.removeAttribute('data-theme')

  probe.remove()
  return bg
}

/* -------------------------------------------------------------------------- */
/* 主入口                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 以 `originEl` 为圆心扩散切换主题。
 *
 * `apply` 负责真正的状态变更（写 localStorage + 翻 `data-theme` + 同步 zustand），
 * 由本函数在正确时机调用：View Transition 要求同步完成，否则快照与实际状态错位。
 *
 * 返回 Promise：扩散结束（或降级直落）后 resolve，方便调用方串接后续动作。
 * 全程 **不拦截点击**（pointer-events:none），也不改 overflow——
 * 临时 hidden 会让布局宽度变化，反而引入横向抖动。
 */
export async function switchThemeWithRipple(
  originEl: HTMLElement | null,
  apply: () => void,
  options: RippleOptions = {}
): Promise<void> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    apply()
    return
  }

  // 减弱动效 / 低性能设备：不播扩散，直接落地。无障碍优先于炫技。
  if (shouldReduceMotion()) {
    teardown()
    apply()
    return
  }

  const { x, y, radius } = resolveOrigin(originEl)
  const duration = options.duration ?? DEFAULT_DURATION
  const theme = options.theme

  // 上一轮没播完就再点：先收干净，保证任何时刻最多一层
  teardown()

  const doc = document as DocumentWithVT
  if (!options.forceFallback && theme && typeof doc.startViewTransition === 'function') {
    const ok = await runViewTransition(doc, apply, theme, x, y, radius, duration)
    if (ok) return
    // 能力检测过了却抛错（浏览器策略禁用等）：落到覆盖层
  }

  await runOverlay(apply, theme, x, y, radius, duration)
}

/* -------------------------------------------------------------------------- */
/* 路径 1：View Transition                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 用 `::view-transition-new(root)` 的 clip-path 揭开新主题。
 *
 * 关键点：
 * - `apply()` 必须在 startViewTransition 的回调里同步执行，浏览器才把它当"新快照"。
 * - 伪元素的动画无法用 JS 逐个挑选，所以把原点/半径写进 <html> 的 CSS 变量，
 *   由 motion.css 里的 `@keyframes cs-vt-reveal` 读取——纯 CSS 参与合成器动画，
 *   比每帧回 JS 更稳。
 * - 动画结束后由 JS 兜底清变量（CSS 的 forwards 只保证视觉，不保证清理）。
 */
async function runViewTransition(
  doc: DocumentWithVT,
  apply: () => void,
  theme: 'light' | 'dark',
  x: number,
  y: number,
  radius: number,
  duration: number
): Promise<boolean> {
  const root = document.documentElement
  const bg = readThemeBg(theme)

  root.style.setProperty('--cs-vt-x', `${x}px`)
  root.style.setProperty('--cs-vt-y', `${y}px`)
  root.style.setProperty('--cs-vt-r', `${radius}px`)
  root.style.setProperty('--cs-vt-d', `${duration}s`)
  root.style.setProperty('--cs-vt-bg', bg)
  // 标记属性驱动 motion.css 里的伪元素规则（属性选择器比 class 更不容易被误删）
  root.setAttribute('data-cs-vt', 'ripple')

  return new Promise<boolean>((resolve) => {
    let vt: ViewTransitionLike
    try {
      vt = doc.startViewTransition!(() => {
        apply()
      })
    } catch {
      resolve(false)
      return
    }
    activeVT = vt

    // 结束函数：正常播完、被新一轮打断、超时兜底三条路径都收敛到这里（幂等）
    const finish = track(() => {
      if (activeVT === vt) {
        activeVT = null
        clearVTVars()
      }
      resolve(true)
    })

    // ready 之后快照已就位、伪元素已挂上动画；此后若用户再点一次，
    // 新一轮的 teardown() 会调用 skipTransition 把这一轮截断。
    vt.ready.then(
      () =>
        Promise.race([vt.finished.catch(() => undefined), delay(duration * 1000 + 200)]).then(
          finish,
          finish
        ),
      finish
    )
  })
}

/** 清掉 <html> 上的扩散参数。幂等。 */
function clearVTVars() {
  const root = document.documentElement
  root.removeAttribute('data-cs-vt')
  const style = root.style
  style.removeProperty('--cs-vt-x')
  style.removeProperty('--cs-vt-y')
  style.removeProperty('--cs-vt-r')
  style.removeProperty('--cs-vt-d')
  style.removeProperty('--cs-vt-bg')
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/* -------------------------------------------------------------------------- */
/* 路径 2：覆盖层（降级）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 一层按**目标主题配色**的覆盖层 + GSAP 圆形扩张。
 *
 * 顺序刻意是「先取色 → 铺层 → 再 apply」：覆盖层在旧画面之上出现的第一帧
 * 就已经是新纸色，用户看到的是颜色从按钮推过来，而不是旧页先闪一下再变。
 */
function runOverlay(
  apply: () => void,
  theme: 'light' | 'dark' | undefined,
  x: number,
  y: number,
  radius: number,
  duration: number
): Promise<void> {
  const bg = theme ? readThemeBg(theme) : ''
  if (!bg) {
    // 读不到 token（样式尚未加载）：宁可不动，也不要黑块
    apply()
    return Promise.resolve()
  }

  return new Promise<void>((resolve) => {
    const layer = document.createElement('div')
    layer.setAttribute('data-cs-theme-ripple', '')
    layer.setAttribute('aria-hidden', 'true')
    layer.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      `z-index:${RIPPLE_Z}`,
      `background:${bg}`,
      'will-change:clip-path,opacity',
    ].join(';')

    // 边缘青柠光圈：只做"洇开的湿润感"，不参与大面积着色
    const glow = document.createElement('div')
    glow.style.cssText = [
      'position:absolute',
      'inset:0',
      `background:radial-gradient(circle ${radius * GLOW_RATIO}px at ${x}px ${y}px, color-mix(in srgb, var(--color-accent) 14%, transparent), transparent 72%)`,
      'opacity:0',
    ].join(';')
    // 光圈初始为 0（上面 cssText 里的 opacity:0），由下面的两条补间控制亮起与淡出
    layer.appendChild(glow)
    document.body.appendChild(layer)
    activeLayer = layer

    apply()

    activeTween = gsap.fromTo(
      layer,
      { clipPath: `circle(0px at ${x}px ${y}px)` },
      {
        clipPath: `circle(${radius}px at ${x}px ${y}px)`,
        duration,
        ease: 'csPaper',
        onComplete: () => {
          // 圆已经盖满屏幕，此时整层淡出等于「墨渗进纸里」，顺带柔化圆边
          activeTween = gsap.to(layer, {
            opacity: 0,
            duration: 0.34,
            ease: 'power2.out',
            onComplete: () => settle(),
          })
        },
      }
    )

    // 光圈跟着主圆亮起，但更快淡掉：只在扩张前沿停留一瞬
    gsap.to(glow, { opacity: 1, duration: duration * 0.42, ease: 'power1.out' })
    gsap.to(glow, { opacity: 0, duration: duration * 0.6, delay: duration * 0.34, ease: 'power2.in' })

    // 安全网：标签页切到后台时 gsap.ticker 会暂停，覆盖层不能永远压着
    overlayTimer = window.setTimeout(() => finish(), (duration + 1.4) * 1000)

    function finish() {
      if (activeLayer !== layer) return
      if (overlayTimer) {
        window.clearTimeout(overlayTimer)
        overlayTimer = 0
      }
      gsap.killTweensOf(layer)
      layer.remove()
      activeLayer = null
      activeTween = null
      settle()
    }
    /** 结算：被新一轮打断时由 teardown() 调用，同样收掉本层节点 */
    const settle = track(() => {
      resolve()
      finish()
    })
  })
}
