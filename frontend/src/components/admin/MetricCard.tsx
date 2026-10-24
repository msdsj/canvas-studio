import type { LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  icon?: LucideIcon
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral'
  /** 卡内迷你趋势线（sparkline）：近 7 天，64px 高 */
  spark?: number[]
  /** 变化提示，如「较昨日 +12%」；没有真实对比数据时不要传 */
  delta?: string
  /** 指标口径说明：悬停标题旁的小图标查看 */
  hint?: string
}

const toneClass: Record<string, string> = {
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-text',
}

const toneSurface: Record<string, string> = {
  brand: 'bg-brand-subtle text-brand-text',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  neutral: 'bg-bg-subtle text-text-secondary',
}

/**
 * 指标卡。
 *
 * v3 改动：
 * - 数字改用 `tabular-nums` 等宽对齐，纵向扫一列能直接比大小；
 * - 图标从右上角挪到标题左侧同一行（原来图标飘在 20px 外，基线对不齐）；
 * - 支持卡内 sparkline 与变化提示——概览页光有数字看不出趋势。
 */
export function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone = 'neutral',
  spark,
  delta,
  hint,
}: MetricCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <p className="truncate text-caption text-text-secondary">{title}</p>
          {hint && <Hint label={hint} />}
        </span>
        {Icon && (
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]',
              toneSurface[tone],
            )}
          >
            <Icon size={15} strokeWidth={1.75} />
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-2">
        <p className={cn('font-mono text-[28px] font-semibold leading-none tabular-nums', toneClass[tone])}>
          {value}
        </p>
        {delta && <span className="text-caption text-text-tertiary">{delta}</span>}
      </div>
      {subtitle && <p className="text-caption text-text-tertiary">{subtitle}</p>}
      {spark && spark.length > 1 && <Sparkline values={spark} tone={tone} />}
    </Card>
  )
}

/** 卡内迷你趋势：纯 SVG，64px 高，只用 --chart-1。 */
function Sparkline({ values, tone }: { values: number[]; tone: string }) {
  const max = Math.max(1, ...values)
  const min = Math.min(...values)
  const span = Math.max(1, max - min)
  const w = 100
  const h = 24
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * w
      const y = h - ((value - min) / span) * h
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  const color = tone === 'success' ? 'var(--chart-2)' : 'var(--chart-1)'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-6 w-full" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity={0.85}
      />
    </svg>
  )
}
