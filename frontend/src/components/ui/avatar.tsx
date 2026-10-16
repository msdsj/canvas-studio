import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cn, colorFromString, initialOf } from '@/lib/utils'

interface AvatarProps {
  name?: string
  src?: string | null
  size?: number
  className?: string
}

/** 圆形头像：无图时用首字母 + 基于名称的颜色。 */
export function Avatar({ name, src, size = 32, className }: AvatarProps) {
  const label = initialOf(name)
  return (
    <AvatarPrimitive.Root
      className={cn('inline-flex select-none items-center justify-center overflow-hidden rounded-full', className)}
      style={{ width: size, height: size }}
    >
      {src ? (
        <AvatarPrimitive.Image
          src={src}
          alt={name || 'avatar'}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-medium text-white"
          style={{ backgroundColor: colorFromString(name || label), fontSize: size * 0.42 }}
        >
          {label}
        </span>
      )}
    </AvatarPrimitive.Root>
  )
}
