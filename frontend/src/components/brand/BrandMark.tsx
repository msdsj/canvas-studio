import { cn } from '@/lib/utils'

/**
 * 品牌标识（MSDSJ）。
 *
 * 用位图而不是 currentColor mask：LOGO 本身带青柠色刀锋面，
 * 在浅色/深色导航栏上都需要保留这个识别点；深色圆角底在任何背景上
 * 都有足够对比度，不需要两套明暗素材。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/msdsj-mark.png"
      alt="MSDSJ"
      width={512}
      height={512}
      draggable={false}
      className={cn('shrink-0 select-none rounded-[22%] object-cover', className)}
    />
  )
}
