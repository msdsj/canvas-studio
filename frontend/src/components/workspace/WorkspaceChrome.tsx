import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  History,
  ImagePlus,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
} from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { LocaleToggle } from '@/components/layout/LocaleToggle'
import { UserMenu } from '@/components/layout/UserMenu'
import { QuotaBadge } from '@/components/layout/QuotaBadge'
import { useAuth } from '@/hooks/use-auth'
import { useUIStore, type StudioTab } from '@/stores/ui'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** 图标按钮的统一形态：32px 方圆角，hover 只换底色，不位移（顶栏里位移会显得抖）。 */
function IconButton({
  label,
  onClick,
  active,
  children,
  className,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-200',
            active
              ? 'bg-accent-soft text-accent-ink'
              : 'text-text-tertiary hover:bg-surface-hover hover:text-text',
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Agent 面板头：品牌 + 「我在和谁协作」+ 面板级操作。
 *
 * 对标 Lovart 左栏顶部：返回首页 / 历史 / 新对话 / 收起，全部是图标，
 * 文字只留一处 Agent 名，避免和下面的对话内容抢注意力。
 */
export function AgentPanelHeader({ onCreateSession }: { onCreateSession: () => void }) {
  const { t } = useTranslation('workspace')
  const setAgentPanelOpen = useUIStore((s) => s.setAgentPanelOpen)
  const toggleStudioDrawer = useUIStore((s) => s.toggleStudioDrawer)
  const drawerOpen = useUIStore((s) => s.studioDrawerOpen)
  const studioTab = useUIStore((s) => s.studioTab)

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border-faint px-2.5">
      <Link
        to="/"
        aria-label={t('agent_panel.home')}
        title={t('agent_panel.home')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-text transition-colors hover:bg-surface-hover"
      >
        <span aria-hidden className="cs-logo-mark h-5 w-5" />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-0.5">
        <span className="truncate text-ui font-semibold tracking-[-0.01em] text-text">
          {t('agent_panel.title')}
        </span>
        <AgentPulse />
      </div>
      <IconButton
        label={t('drawer.chats')}
        active={drawerOpen && studioTab === 'chats'}
        onClick={() => toggleStudioDrawer('chats')}
      >
        <History size={16} />
      </IconButton>
      <IconButton label={t('agent_panel.new_chat')} onClick={onCreateSession}>
        <MessageSquarePlus size={16} />
      </IconButton>
      <IconButton
        label={t('agent_panel.collapse')}
        onClick={() => setAgentPanelOpen(false)}
        className="hidden md:flex"
      >
        <PanelLeftClose size={16} />
      </IconButton>
    </div>
  )
}

/**
 * Agent 在线指示：一颗青柠点 + 一圈慢速外扩的光环。
 * 不用 animate-ping：ping 是 1s 一次的急促闪，放在常驻头部会让人焦虑；
 * 这里 2.4s 一个呼吸周期，和「待命」这个状态的情绪一致。
 *
 * 注意：光环用 CSS 动画（`.cs-agent-pulse`）而不是 GSAP 补间。
 * 此前用 `gsap.fromTo(..., { repeat: -1 })` 实现，会让 GSAP ticker 永不空闲，
 * 整个工作台空转 60fps——纯装饰动画不值得付这个代价。
 * `prefers-reduced-motion` 由 index.css 的全局规则统一兜底。
 */
function AgentPulse() {
  return (
    <span className="relative flex h-2 w-2 shrink-0 items-center justify-center" aria-hidden>
      <span className="cs-agent-pulse absolute h-2 w-2 rounded-full bg-accent-strong" />
      <span className="relative h-1.5 w-1.5 rounded-full bg-accent-strong" />
    </span>
  )
}

const DRAWER_TABS: Array<{ id: StudioTab; icon: typeof History }> = [
  { id: 'chats', icon: History },
  { id: 'refs', icon: ImagePlus },
  { id: 'works', icon: Sparkles },
]

/**
 * 画布顶栏（画布列上方，不压在画布上——画布顶部中央留给绘图工具岛）。
 *
 * 左：展开 Agent（收起时）+ 工作室抽屉三分区 + 画布名/保存态（由调用方传入）
 * 右：积分 · 通知 · 主题 · 语言 · 账号
 *
 * 抽屉分区的选中态是一枚滑动胶囊（GSAP 跟随），和首页/侧栏的分段控件同一种手感。
 */
export function CanvasTopBar({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('workspace')
  const { user } = useAuth()
  const agentPanelOpen = useUIStore((s) => s.agentPanelOpen)
  const setAgentPanelOpen = useUIStore((s) => s.setAgentPanelOpen)
  const toggleStudioDrawer = useUIStore((s) => s.toggleStudioDrawer)
  const drawerOpen = useUIStore((s) => s.studioDrawerOpen)
  const studioTab = useUIStore((s) => s.studioTab)

  const groupRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const group = groupRef.current
    const pill = pillRef.current
    if (!group || !pill) return
    const target = group.querySelector<HTMLElement>(`[data-tab="${studioTab}"]`)
    if (!drawerOpen || !target) {
      gsap.to(pill, { autoAlpha: 0, scale: 0.8, duration: 0.2, ease: 'power2.out' })
      return
    }
    const vars = { x: target.offsetLeft, autoAlpha: 1, scale: 1 }
    if (shouldReduceMotion()) gsap.set(pill, vars)
    else gsap.to(pill, { ...vars, duration: 0.45, ease: 'csSnap' })
  }, [drawerOpen, studioTab])

  const avatarTrigger = (
    <button
      type="button"
      aria-label={user?.email ?? 'account'}
      className="ml-0.5 shrink-0 rounded-full ring-1 ring-border/70 transition-transform duration-200 hover:scale-[1.06] active:scale-95"
    >
      <Avatar name={user?.display_name || user?.email} size={28} />
    </button>
  )

  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 px-1">
      {!agentPanelOpen && (
        <IconButton
          label={t('agent_panel.expand')}
          onClick={() => setAgentPanelOpen(true)}
          className="hidden md:flex"
        >
          <PanelLeftOpen size={16} />
        </IconButton>
      )}

      <div
        ref={groupRef}
        role="toolbar"
        aria-label={t('drawer.title')}
        className="relative flex shrink-0 items-center gap-0.5 rounded-[12px] bg-surface p-0.5 shadow-xs ring-1 ring-inset ring-border-faint"
      >
        <span
          ref={pillRef}
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0.5 h-8 w-8 rounded-[10px] bg-accent-soft opacity-0"
        />
        {DRAWER_TABS.map((item) => {
          const Icon = item.icon
          const active = drawerOpen && studioTab === item.id
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-tab={item.id}
                  onClick={() => toggleStudioDrawer(item.id)}
                  aria-label={t(`drawer.${item.id}`)}
                  aria-pressed={active}
                  className={cn(
                    'relative flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors duration-200',
                    active ? 'text-accent-ink' : 'text-text-tertiary hover:text-text'
                  )}
                >
                  <Icon size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t(`drawer.${item.id}`)}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <div className="min-w-0 flex-1">{children}</div>

      <div className="flex shrink-0 items-center gap-0.5">
        <QuotaBadge chip />
        <span className="hidden sm:flex">
          <NotificationBell iconOnly />
        </span>
        <span className="hidden sm:flex">
          <ThemeToggle compact />
        </span>
        <span className="hidden sm:flex">
          <LocaleToggle compact />
        </span>
        <UserMenu trigger={avatarTrigger} />
      </div>
    </div>
  )
}
