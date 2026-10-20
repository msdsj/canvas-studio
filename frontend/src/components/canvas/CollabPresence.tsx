import { useTranslation } from 'react-i18next'
import { Wifi, WifiOff } from 'lucide-react'
import type { CollabParticipant } from '@/lib/api/collab'
import type { CollabStatus } from '@/hooks/use-canvas-collab'
import { cn } from '@/lib/utils'

interface CollabPresenceProps {
  status: CollabStatus
  participants: CollabParticipant[]
  /** 当前登录用户 id：用于跳过自己那颗头像 */
  selfId?: string
  className?: string
}

/**
 * 协作者在线条。
 *
 * 三件事按重要性排序：
 * 1. **别人来没来**（头像堆叠 + 数量）——决定「我现在改的东西会不会和人打架」；
 * 2. **我连上没有**（状态点）——断线还闷头编辑是最糟的，改动只在本地；
 * 3. **别人改的是哪一块**（颜色映射到设置里的 presence 高亮）。
 *
 * 刻意不用大号横幅：这是背景信息，不是需要行动的通知。打扰越小越好。
 */
export function CollabPresence({ status, participants, selfId, className }: CollabPresenceProps) {
  const { t } = useTranslation('canvas')

  // 个人画布（idle）完全不渲染：没有第二个人，这块 UI 只是噪音
  if (status === 'idle') return null

  const others = participants.filter((item) => item.user_id !== selfId)
  const offline = status === 'offline'

  const statusLabel = offline
    ? t('collab.offline', { defaultValue: '协作未连接' })
    : status === 'online'
      ? others.length > 0
        ? t('collab.online_count', {
            defaultValue: '{{count}} 人正在编辑',
            count: others.length + 1,
          })
        : t('collab.online_alone', { defaultValue: '协作已连接' })
      : t('collab.connecting', { defaultValue: '正在连接协作…' })

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full border border-border/70 bg-surface/95 px-2 py-1 shadow-sheet backdrop-blur',
        className,
      )}
      title={statusLabel}
    >
      <span className="flex items-center" aria-hidden>
        {others.slice(0, 4).map((participant, index) => (
          <span
            key={participant.id}
            className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface text-[9px] font-semibold text-white"
            style={{
              background: participant.color,
              marginLeft: index === 0 ? 0 : -6,
              zIndex: 10 - index,
            }}
          >
            {participant.name.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {others.length > 4 && (
          <span className="-ml-1.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface bg-bg-subtle text-[9px] text-text-secondary">
            +{others.length - 4}
          </span>
        )}
      </span>

      <span className="flex items-center gap-1 text-[10px] leading-none text-text-tertiary">
        {offline ? (
          <WifiOff size={11} className="text-text-tertiary" />
        ) : (
          <Wifi
            size={11}
            className={cn(
              status === 'online' ? 'text-accent-strong' : 'animate-pulse text-text-tertiary',
            )}
          />
        )}
        <span className="hidden sm:inline">
          {offline
            ? t('collab.offline_short', { defaultValue: '离线' })
            : others.length > 0
              ? others.length + 1
              : ''}
        </span>
      </span>
    </div>
  )
}