import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import './home.css'

export type ArtPalette =
  | 'nebula'
  | 'sunset'
  | 'mint'
  | 'peach'
  | 'ocean'
  | 'forest'
  | 'mono'
  | 'candy'

export type ArtMotif = 'orb' | 'bottle' | 'mountain' | 'type' | 'logo' | 'portrait' | 'none'

interface ArtSwatchProps {
  palette: ArtPalette
  motif?: ArtMotif
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

/**
 * 一张「生成好的作品」的抽象替身：渐变底 + 几何主体。
 *
 * 首页不依赖任何外链图片——离线、内网、CDN 挂掉时都完整；
 * 几何主体只是暗示画面内容（海报文字条 / 香水瓶 / 山 / 人像），
 * 不假装是真实作品，避免用户把示意图当成承诺的出图效果。
 */
export function ArtSwatch({ palette, motif = 'none', className, style, children }: ArtSwatchProps) {
  return (
    <div aria-hidden className={cn('cs-art', `cs-art--${palette}`, className)} style={style}>
      {motif === 'orb' && (
        <>
          <span className="cs-motif cs-motif-orb" />
          <span className="cs-motif cs-motif-ring" />
        </>
      )}
      {motif === 'bottle' && <span className="cs-motif cs-motif-bottle" />}
      {motif === 'mountain' && <span className="cs-motif cs-motif-mountain" />}
      {motif === 'logo' && <span className="cs-motif cs-motif-logo" />}
      {motif === 'portrait' && <span className="cs-motif cs-motif-portrait" />}
      {motif === 'type' && (
        <span className="cs-motif cs-motif-type">
          <span />
          <span />
          <span />
        </span>
      )}
      {children}
    </div>
  )
}
