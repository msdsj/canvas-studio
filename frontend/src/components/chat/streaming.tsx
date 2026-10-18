import { useEffect, useRef } from 'react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion, tweenNumber, DURATION, EASE } from '@/lib/motion'

/**
 * 流式展示的动效基底。
 *
 * 只做三件事，且都只动 transform / opacity：
 *  1. `Typewriter`   文本按 token 递进出现（中文按字、英文按词）；
 *  2. `TickingNumber` 数字滚动（GSAP 补间一个对象再写 textContent，不逐帧 setState）；
 *  3. `useGrowOnMount` 元素首次挂载时从 0 长出来（连接线 / 芯片）。
 *
 * 所有组件在 `prefers-reduced-motion` 或低性能设备下**直接全量显示**——
 * 无障碍优先于炫技，而且用户读到的信息一模一样。
 */

/** 英文/数字/URL 按词，中文逐字，标点与空白跟随前一个 token，不单独闪一下。 */
const TOKEN_RE =
  /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]|[A-Za-z0-9]+[’'\-/.:]?[A-Za-z0-9]*|[^\sA-Za-z0-9\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+|\s+/g

interface Segment {
  text: string
  /** 每一小片都是独立元素（中文逐字），还是一个完整词（英文短语 / 空白） */
  atomic: boolean
}

export function segmentize(text: string): Segment[] {
  const matches = text.match(TOKEN_RE) ?? []
  const segments: Segment[] = []
  for (const token of matches) {
    const last = segments[segments.length - 1]
    const isSpace = !token.trim()
    // 空白 / 标点并入上一片，避免「，」「 」单独占一次动画节拍
    if (last && (isSpace || !/[\w\u4e00-\u9fa5]/.test(token))) {
      last.text += token
      continue
    }
    const atomic = token.trim().length > 1
    if (atomic) segments.push({ text: token, atomic: true })
    else segments.push({ text: token, atomic: false })
  }
  return segments
}

interface TypewriterProps {
  text: string
  /** 每个 token 的间隔 */
  speed?: number
  /** 起始延迟 */
  delay?: number
  /** 正在流式的文字：结束后要有一个青柠光标停一下 */
  live?: boolean
  className?: string
}

/**
 * 打字机文本。
 *
 * 用逐字 span（每个 span 初始 `opacity:0`，GSAP 依次点亮）而不是定时截断字符串：
 * - 不产生每秒几十次的 React 重渲染（文字长度变化会让整块布局重排）；
 * - 中文换行位置从一开始就确定，打字过程中不会「跳行」。
 * DOM 里同时保留一份完整的视觉隐藏文本给阅读器，避免读屏器逐字念。
 *
 * 节奏：单个字 22ms 太「机械」，按 40ms 更接近真人在敲键盘；整段最长不超过
 * `MAX_TOTAL`，否则一句 80 字的 detail 要等 3 秒——信息该早点到就早点到。
 */
const MAX_TOTAL = 1.1

export function Typewriter({ text, speed = 0.04, delay = 0.06, live = false, className }: TypewriterProps) {
  const segments = segmentize(text)
  const plain = shouldReduceMotion() || segments.every((segment) => !segment.atomic)

  const hostRef = useRef<HTMLSpanElement | null>(null)
  const caretRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chars = Array.from(host.querySelectorAll<HTMLElement>('[data-tw]'))
    const caret = caretRef.current
    const reduce = shouldReduceMotion()
    if (chars.length === 0) {
      if (caret) gsap.set(caret, { opacity: 0 })
      return
    }
    // 减弱动效：一次性全量显示，光标也不要闪
    if (reduce) {
      gsap.set(chars, { opacity: 1, y: 0, clearProps: 'transform' })
      if (caret) gsap.set(caret, { opacity: 0 })
      return
    }

    // 长文本压缩间隔，保证整段不超过 MAX_TOTAL
    const stagger = Math.min(speed, MAX_TOTAL / chars.length)

    const ctx = gsap.context(() => {
      gsap.set(chars, { opacity: 0, y: plain ? 3 : 0 })
      const tl = gsap.timeline({ delay })
      tl.to(chars, {
        opacity: 1,
        y: 0,
        duration: 0.16,
        ease: 'none',
        stagger,
        overwrite: 'auto',
        onComplete: () => {
          gsap.set(chars, { clearProps: 'transform' })
          if (live && caret) {
            gsap.fromTo(
              caret,
              { opacity: 0 },
              { opacity: 1, duration: 0.5, repeat: -1, yoyo: true, ease: 'sine.inOut' }
            )
          }
        },
      })
    }, host)

    return () => ctx.revert()
  }, [text, speed, delay, live, plain])

  return (
    <span className={className} data-stream-text="">
      <span className="sr-only">{text}</span>
      <span ref={hostRef} aria-hidden>
        {segments.map((segment, index) =>
          segment.atomic ? (
            <span
              key={`${index}-${segment.text}`}
              data-tw
              className="will-change-[opacity]"
            >
              {segment.text}
            </span>
          ) : (
            <span
              key={`${index}-${segment.text}`}
              data-tw
              className="inline-block whitespace-pre will-change-[opacity]"
            >
              {segment.text}
            </span>
          )
        )}
        {live && (
          <span
            ref={caretRef}
            aria-hidden
            className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.12em] rounded-full bg-accent align-middle"
          />
        )}
      </span>
    </span>
  )
}

interface TickingNumberProps {
  value: number
  /** 毫秒数字更短：240ms 比 420ms 更跟得上节奏 */
  duration?: number
  suffix?: string
  className?: string
}

/** 数字滚动：补间一个 state 对象，`onUpdate` 里写 textContent。 */
export function TickingNumber({ value, duration = DURATION.base, suffix = '', className }: TickingNumberProps) {
  const ref = useRef<HTMLSpanElement | null>(null)
  const prevRef = useRef(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const from = prevRef.current
    prevRef.current = value
    if (shouldReduceMotion() || from === value) {
      el.textContent = `${value}${suffix}`
      return
    }
    // tweenNumber 固定用 slow 档；这里要更短，直接用手写补间保持节奏一致
    if (duration === DURATION.slow) {
      tweenNumber(el, from, value, (v) => `${Math.round(v)}${suffix}`)
      return
    }
    const state = { value: from }
    const tween = gsap.to(state, {
      value,
      duration,
      ease: EASE.out,
      onUpdate: () => {
        el.textContent = `${Math.round(state.value)}${suffix}`
      },
    })
    return () => {
      tween.kill()
    }
  }, [value, duration, suffix])

  return (
    <span ref={ref} className={className}>
      {value}
      {suffix}
    </span>
  )
}

/**
 * 首次挂载的「生长」：竖向是连接线（scaleY），横向是箭头（scaleX）。
 * 依赖数组里的值变化时**不重播**——整段链路只长一次，否则每次 SSE 到达都会抽一下。
 */
export function useGrowOnMount<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  axis: 'y' | 'x' = 'y',
  delay = 0
) {
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el || done.current) return
    done.current = true
    if (shouldReduceMotion()) {
      gsap.set(el, { clearProps: 'transform' })
      return
    }
    const from = axis === 'y' ? { scaleY: 0 } : { scaleX: 0 }
    const tween = gsap.from(el, {
      ...from,
      duration: 0.36,
      delay,
      ease: EASE.inOut,
      clearProps: 'transform',
    })
    return () => {
      tween.kill()
    }
  }, [ref, axis, delay])
}

/** 骨架「扫光」：一条极窄的青柠高光从占位条中间穿过。 */
export function SweepBar({ className }: { className?: string }) {
  return (
    <span className={`relative block overflow-hidden rounded-full ${className ?? ''}`}>
      <span className="cs-shimmer absolute inset-0 opacity-70" aria-hidden />
    </span>
  )
}
