import { useState } from 'react'
import { ImageOff } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SmartImageProps {
  src: string
  alt: string
  /** 图片自身的尺寸/圆角/适配类 */
  className?: string
  /** 外层容器类（用于占位与骨架定位） */
  wrapperClassName?: string
  /** 失败时的说明文案 */
  failedLabel?: string
  retryLabel?: string
  /** 点「重试」时若外部需要额外动作（如重新拉任务），在这里回调 */
  onRetry?: () => void
}

/**
 * 带渐进加载与失败占位的图片。
 *
 * 三件事缺一不可：
 * 1. 加载中先模糊再清晰，避免"啪"地一下跳出来；
 * 2. 失败时保持容器尺寸不塌（否则整页布局抖动），并给可点的重试；
 * 3. 重试走 cache-bust，避免命中浏览器缓存的失败响应。
 */
export function SmartImage({
  src,
  alt,
  className,
  wrapperClassName,
  failedLabel = '图片加载失败',
  retryLabel = '重试',
  onRetry,
}: SmartImageProps) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [nonce, setNonce] = useState(0)

  const url = nonce > 0 ? `${src}${src.includes('?') ? '&' : '?'}_r=${nonce}` : src

  if (status === 'error') {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-1 bg-mat text-center',
          wrapperClassName
        )}
      >
        <ImageOff size={18} className="text-text-faint" />
        <span className="text-caption text-text-tertiary">{failedLabel}</span>
        <button
          type="button"
          className="text-caption text-brand-text underline-offset-2 hover:underline"
          onClick={(event) => {
            event.stopPropagation()
            setStatus('loading')
            setNonce((n) => n + 1)
            onRetry?.()
          }}
        >
          {retryLabel}
        </button>
      </div>
    )
  }

  return (
    <div className={cn('relative overflow-hidden bg-mat', wrapperClassName)}>
      <img
        src={url}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('error')}
        className={cn(
          'transition-[opacity,filter,transform] duration-300 ease-out',
          status === 'ready' ? 'scale-100 opacity-100 blur-0' : 'scale-[1.03] opacity-0 blur-[6px]',
          className
        )}
      />
    </div>
  )
}
