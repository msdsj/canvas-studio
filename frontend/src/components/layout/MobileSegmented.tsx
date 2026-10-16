import { useTranslation } from 'react-i18next'
import { PenSquare, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'

/** 移动端「画布 / 对话」分段切换（P0-27）。 */
export function MobileSegmented() {
  const { t } = useTranslation('chat')
  const segment = useUIStore((s) => s.mobileSegment)
  const setSegment = useUIStore((s) => s.setMobileSegment)

  const items = [
    { key: 'canvas' as const, label: t('mode.chat') === 'Chat' ? 'Canvas' : '画布', icon: PenSquare },
    { key: 'chat' as const, label: t('panel_title'), icon: MessageSquare },
  ]

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface p-1 md:hidden">
      {items.map((item) => {
        const Icon = item.icon
        const active = segment === item.key
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => setSegment(item.key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-2 rounded-md py-2 text-sm',
              active ? 'bg-brand-subtle text-brand-text' : 'text-text-secondary'
            )}
          >
            <Icon size={16} />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
