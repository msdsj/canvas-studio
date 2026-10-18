import { useTranslation } from 'react-i18next'
import { PenSquare, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/stores/ui'

/**
 * 移动端「画布 / 对话」分段切换（<md 才出现）。
 *
 * 桌面端三栏并排；移动端一次只能看一栏，所以退化成一个明确的二选一胶囊，
 * 而不是把三栏挤成三条细缝。左栏（工作室）在移动端从顶部菜单进入。
 */
export function MobileSegmented() {
  const { t } = useTranslation('chat')
  const segment = useUIStore((s) => s.mobileSegment)
  const setSegment = useUIStore((s) => s.setMobileSegment)

  const items = [
    { key: 'canvas' as const, label: t('mode.chat') === 'Chat' ? 'Canvas' : '画布', icon: PenSquare },
    { key: 'chat' as const, label: t('panel_title'), icon: MessageSquare },
  ]

  return (
    // 分段控件：滑块由 [data-motion-slider] 声明，位置由 motion-delegation 统一计算，
    // 所以这里的按钮不再各自带 bg 类——否则会看到"两层底色"一起滑
    <div
      data-motion-group
      className="mx-2.5 mb-1.5 flex shrink-0 items-center gap-1 rounded-full bg-surface p-1 shadow-sheet md:hidden"
    >
      <span data-motion-slider aria-hidden />
      {items.map((item) => {
        const Icon = item.icon
        const active = segment === item.key
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => setSegment(item.key)}
            aria-pressed={active}
            data-motion="segment"
            className={cn(
              'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-caption font-medium',
              active ? 'text-text' : 'text-text-tertiary hover:text-text-secondary'
            )}
          >
            <Icon size={14} />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
