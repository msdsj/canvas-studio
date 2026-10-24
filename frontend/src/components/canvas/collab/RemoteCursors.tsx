import type { CollabParticipant } from '@/lib/api/collab'
import { cn } from '@/lib/utils'
import type { Viewport } from './CollabPanel'

interface RemoteCursorsProps {
  participants: CollabParticipant[]
  selfId?: string
  viewport: Viewport
}

/**
 * 协作者光标。
 *
 * 坐标是场景坐标，按当前视口换算成屏幕位置——所以别人在画布另一头移动时，
 * 他的光标会跟着一起平移/缩放，而不是钉在屏幕上。
 *
 * 只画不拦：整层 `pointer-events-none`，不能挡住任何画布操作。
 */
export function RemoteCursors({ participants, selfId, viewport }: RemoteCursorsProps) {
  const others = participants.filter(
    (item) => item.user_id !== selfId && item.cursor
  )
  if (others.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-[17] overflow-hidden">
      {others.map((item) => {
        const left = (item.cursor!.x + viewport.scrollX) * viewport.zoom
        const top = (item.cursor!.y + viewport.scrollY) * viewport.zoom
        return (
          <div
            key={item.id}
            className="absolute left-0 top-0 transition-transform duration-100 ease-linear"
            style={{ transform: `translate3d(${left}px, ${top}px, 0)` }}
          >
            <svg width="16" height="20" viewBox="0 0 16 20" fill="none" aria-hidden>
              <path
                d="M1 1L14.2 9.4L8.3 10.6L5.6 18.6L1 1Z"
                fill={item.color}
                stroke="white"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className={cn(
                'ml-3 inline-block max-w-[120px] truncate rounded-full px-1.5 py-0.5 text-[9px] font-medium text-white shadow-sm'
              )}
              style={{ background: item.color }}
            >
              {item.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}
