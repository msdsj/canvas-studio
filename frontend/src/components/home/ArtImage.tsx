import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface ArtImageProps {
  src: string
  alt: string
  className?: string
  style?: CSSProperties
  /** 预览/首屏用 eager，画廊用 lazy */
  priority?: boolean
  /** 让主体在小尺寸裁切时保持在画面里 */
  position?: string
  children?: ReactNode
}

/**
 * 首页的「作品图」。
 *
 * 只做一件事：把真实生成的图片按容器比例裁切铺满，并给一层很淡的内阴影，
 * 让图片像被装进画框而不是贴在页面上。图片本身固定色彩，不跟明暗主题变。
 */
export function ArtImage({ src, alt, className, style, priority, position, children }: ArtImageProps) {
  return (
    <div className={cn('relative overflow-hidden bg-bg-subtle', className)} style={style}>
      <img
        src={src}
        alt={alt}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        draggable={false}
        className="absolute inset-0 h-full w-full select-none object-cover"
        style={{ objectPosition: position ?? '50% 50%' }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-black/[0.06]"
      />
      {children}
    </div>
  )
}
