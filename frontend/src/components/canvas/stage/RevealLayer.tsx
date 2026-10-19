import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { sceneBoxToScreen, type ExcalidrawApiLike } from '../canvas-helpers'

type Box = { x: number; y: number; w: number; h: number }

export interface RevealLayerHandle {
  /** 在这些 scene 矩形上播放一次「显影」 */
  reveal: (boxes: Box[]) => void
}

interface RevealItem {
  id: number
  box: Box
}

/**
 * 结果落画布时的「显影」动效层。
 *
 * Excalidraw 把图片画在 <canvas> 像素里，我们无法直接对那张图做 CSS 动画。
 * 做法是在图片上方盖一块同尺寸的磨砂片：`backdrop-filter: blur()` 从 18px 退到 0，
 * 透过它看到的画面就是「从模糊慢慢对焦清晰」；同时一圈青柠光边收拢、淡出。
 * 磨砂片每帧按当前视口重算位置——落图时镜头正在推近（focusSceneBox），不跟随会错位。
 * 整层 pointer-events: none，绝不拦截画布操作。
 */
export const RevealLayer = forwardRef<RevealLayerHandle, { api: ExcalidrawApiLike | null }>(
  function RevealLayer({ api }, ref) {
    const [items, setItems] = useState<RevealItem[]>([])
    const nodesRef = useRef(new Map<number, HTMLDivElement>())
    const seqRef = useRef(0)
    const apiRef = useRef(api)
    apiRef.current = api

    useImperativeHandle(ref, () => ({
      reveal: (boxes) => {
        if (shouldReduceMotion() || boxes.length === 0) return
        const next = boxes
          .filter((box) => box.w > 0 && box.h > 0)
          .map((box) => ({ id: ++seqRef.current, box }))
        if (next.length > 0) setItems((prev) => [...prev, ...next])
      },
    }))

    // 跟随视口：只在有动效时跑 rAF，直接写 transform，不经过 React
    useEffect(() => {
      if (items.length === 0) return
      let raf = 0
      const follow = () => {
        raf = requestAnimationFrame(follow)
        for (const item of items) {
          const node = nodesRef.current.get(item.id)
          const rect = sceneBoxToScreen(apiRef.current, item.box)
          if (!node || !rect) continue
          node.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
          node.style.width = `${rect.w}px`
          node.style.height = `${rect.h}px`
        }
      }
      follow()
      return () => cancelAnimationFrame(raf)
    }, [items])

    return (
      <div aria-hidden className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
        {items.map((item, index) => (
          <RevealPlate
            key={item.id}
            delay={index * 0.08}
            register={(node) => {
              if (node) nodesRef.current.set(item.id, node)
              else nodesRef.current.delete(item.id)
            }}
            onDone={() => setItems((prev) => prev.filter((entry) => entry.id !== item.id))}
          />
        ))}
      </div>
    )
  }
)

function RevealPlate({
  delay,
  register,
  onDone,
}: {
  delay: number
  register: (node: HTMLDivElement | null) => void
  onDone: () => void
}) {
  const plateRef = useRef<HTMLDivElement>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useLayoutEffect(() => {
    const plate = plateRef.current
    if (!plate) return
    const ring = plate.querySelector<HTMLElement>('[data-ring]')
    const sheen = plate.querySelector<HTMLElement>('[data-sheen]')
    const tint = plate.querySelector<HTMLElement>('[data-tint]')
    const blur = { value: 18 }
    const tl = gsap.timeline({ delay, onComplete: () => doneRef.current() })
    tl.set(plate, { autoAlpha: 1 })
      .to(
        blur,
        {
          value: 0,
          duration: 1.1,
          ease: 'power2.out',
          onUpdate: () => {
            const v = `blur(${blur.value.toFixed(2)}px) saturate(${1 + blur.value / 40})`
            plate.style.backdropFilter = v
            plate.style.setProperty('-webkit-backdrop-filter', v)
          },
        },
        0
      )
      .fromTo(tint, { autoAlpha: 1 }, { autoAlpha: 0, duration: 1.1, ease: 'power1.out' }, 0)
      .fromTo(ring, { scale: 1.08, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.5, ease: 'expo.out' }, 0)
      .fromTo(sheen, { xPercent: -120 }, { xPercent: 220, duration: 0.9, ease: 'power2.inOut' }, 0.15)
      .to(ring, { autoAlpha: 0, duration: 0.45, ease: 'power1.in' }, 0.85)
      .to(plate, { autoAlpha: 0, duration: 0.25 }, 1.1)
    return () => {
      tl.kill()
    }
  }, [delay])

  return (
    <div
      ref={(node) => {
        plateRef.current = node
        register(node)
      }}
      className="invisible absolute left-0 top-0 overflow-hidden rounded-[4px] opacity-0 will-change-transform"
    >
      <span data-tint className="absolute inset-0 bg-accent/20" />
      <span data-ring className="absolute inset-0 rounded-[4px] ring-2 ring-accent-strong" style={{ boxShadow: 'var(--shadow-glow)' }} />
      <span data-sheen className="cs-reveal-sheen absolute inset-y-0 left-0 w-1/2" />
    </div>
  )
}
