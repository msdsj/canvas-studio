import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Moon, Sun, Monitor } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/use-theme'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

/**
 * 主题切换（浅色 / 深色 / 跟随系统）。
 *
 * 两层反馈叠加：
 *  1. **页面级**——新主题以这颗按钮为圆心向四周扩散（见 lib/theme-transition.ts）。
 *     所以按钮的 ref 必须原样传给 setMode 作为扩散原点，这是整段动效的"因果起点"。
 *  2. **按钮级**——图标出场：旧图标缩小转走、新图标带一点过冲弹进来，
 *     青柠色短促高亮一下。单靠页面扩散时，按钮自己反而显得没反应。
 *
 * 三态（light → dark → system → light）保持不变：扩散只是视觉层，
 * 不参与任何状态判断。
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('common')
  const { mode, setMode } = useTheme()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const iconRef = useRef<HTMLSpanElement>(null)
  const ringRef = useRef<HTMLSpanElement>(null)

  /**
   * 两段动效同时打在按钮上：图标自己的旋转缩放，以及整页的扩散。
   * 扩散量的是**按钮**的 rect（按钮本身不动，只有内层图标在转），所以互不干扰。
   */

  const next = mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light'
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor

  const handleClick = () => {
    const icon = iconRef.current
    const ring = ringRef.current
    const reduced = shouldReduceMotion()

    if (icon && !reduced) {
      gsap.killTweensOf(icon)
      gsap
        .timeline()
        // 旧图标先退：转 + 缩，像被拧下来
        .to(icon, { rotate: -75, scale: 0.4, opacity: 0, duration: 0.16, ease: 'power2.in' })
        // 换完 glyph 后新图标带着过冲弹回原位（React 在同一帧重渲染，不会有白帧）
        .set(icon, { rotate: 35, scale: 0.6 })
        .to(icon, { rotate: 0, scale: 1, opacity: 1, duration: 0.42, ease: 'csSnap' })
    }
    if (ring && !reduced) {
      // 青柠光圈：只做一次短促的点亮，不做持续脉冲——持续闪烁等于噪音
      gsap.killTweensOf(ring)
      gsap.fromTo(
        ring,
        { scale: 0.6, opacity: 0.55 },
        { scale: 1.5, opacity: 0, duration: 0.55, ease: 'power2.out' }
      )
    }

    // 原点 = 这颗按钮：扩散必须精准从这里出发
    setMode(next, buttonRef.current)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          onClick={handleClick}
          aria-label={t('theme.toggle')}
          className={cn(
            'relative flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text',
            compact ? 'h-7 w-7' : 'h-9 w-9'
          )}
        >
          {/* 点击瞬间的青柠光圈：绝对定位铺满按钮，不参与布局 */}
          <span
            ref={ringRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-full bg-accent/45 opacity-0"
          />
          <span ref={iconRef} className="relative flex">
            <Icon size={compact ? 15 : 18} />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t(`theme.${mode}`)}</TooltipContent>
    </Tooltip>
  )
}
