import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

export const buttonVariants = cva(
  // 基础层必须自带 text-text：不设颜色时按钮会继承父级颜色，
  // 一旦父级是深色文字、按钮又是深色底（primary），文字会与底色同色而"消失"。
  //
  // 动效约定：按压/微抬统一交给 lib/motion-delegation 的 GSAP 委托（data-motion="press"），
  // 所以变体类里不再写 active:scale-* / hover:-translate-y——重复声明会和 GSAP 的内联
  // transform 互相覆盖，表现为"按下去抖两下"。这里的 transition 只管颜色、阴影、滤镜。
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-text font-medium tracking-[-0.005em] transition-[background-color,box-shadow,color,opacity,transform,filter] duration-150 ease-[var(--ease-out)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-40 disabled:saturate-50',
  {
    variants: {
      variant: {
        primary:
          'cs-gradient-brand !text-text-inverse shadow-xs hover:brightness-110 hover:shadow-sm active:brightness-95',
        secondary:
          'border border-border-strong bg-surface text-text hover:bg-surface-hover hover:shadow-xs',
        ghost: 'bg-transparent text-text-secondary hover:bg-surface-hover hover:text-text',
        danger: 'bg-danger text-white hover:opacity-90',
        link: 'h-auto bg-transparent p-0 text-brand-text underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-caption',
        md: 'h-9 px-4 text-ui',
        lg: 'h-11 px-5 text-body',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || loading}
        // 声明式按压：由 lib/motion-delegation 全局接管（0.97 + back.out 弹回）。
        // 变体里的 active:scale-* 是兜底（委托未安装时才有意义），两者不同时生效。
        data-motion="press"
        {...props}
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            {children}
          </span>
        ) : (
          children
        )}
      </Comp>
    )
  }
)
Button.displayName = 'Button'
