import type { LucideIcon } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  icon?: LucideIcon
  tone?: 'brand' | 'success' | 'warning' | 'danger' | 'neutral'
}

const toneClass: Record<string, string> = {
  brand: 'text-brand',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-text',
}

/** 指标卡。 */
export function MetricCard({ title, value, subtitle, icon: Icon, tone = 'neutral' }: MetricCardProps) {
  return (
    <Card className="flex items-start justify-between">
      <div>
        <p className="text-sm text-text-secondary">{title}</p>
        <p className={cn('mt-2 text-2xl font-bold', toneClass[tone])}>{value}</p>
        {subtitle && <p className="mt-1 text-xs text-text-tertiary">{subtitle}</p>}
      </div>
      {Icon && <Icon size={20} className={cn('mt-1', toneClass[tone])} />}
    </Card>
  )
}
