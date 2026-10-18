import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Images, LayoutGrid, ListChecks, Settings, Wallet } from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { QuotaBadge } from './QuotaBadge'
import { NotificationBell } from './NotificationBell'
import { UserMenu } from './UserMenu'
import { useAuth } from '@/hooks/use-auth'

const NAV = [
  { to: '/workspace', key: 'workspace', icon: LayoutGrid },
  { to: '/projects', key: 'projects', icon: FolderOpen },
  { to: '/assets', key: 'assets', icon: Images },
  { to: '/tasks', key: 'tasks', icon: ListChecks },
] as const

const ACCOUNT = [
  { to: '/usage', key: 'usage', icon: Wallet },
  { to: '/settings', key: 'settings', icon: Settings },
] as const

/**
 * 顶部通栏。
 *
 * 工作区（`/workspace`）里**整条不渲染**：那里 48px 高度要留给画布，
 * 身份区（工作室名 / 消息 / 额度 / 账号）改由左栏左上角承担，
 * 导航从左侧栏与头像菜单进入。
 *
 * 其它页面（项目 / 素材 / 任务 / 用量…）仍是列表型页面，需要一条明确的
 * 返回与切换入口，所以保留这条轻量顶栏。
 */
export function TopBar() {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const canvasName = useCanvasStore((s) => s.canvas?.name)
  const { isPro } = useAuth()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // 画布/项目属 Pro 能力：普通用户的切换菜单里不出现该入口
  const nav = isPro ? NAV : NAV.filter((item) => item.to !== '/projects')

  if (pathname.startsWith('/workspace')) return null

  return (
    <header className="mx-2.5 mt-2.5 flex h-11 shrink-0 items-center justify-between gap-3 rounded-[14px] bg-surface/70 px-2 shadow-sheet ring-1 ring-inset ring-border-faint backdrop-blur-md">
      <div className="flex min-w-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('nav.workspace')}
              className="flex h-7 w-7 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <LayoutGrid size={15} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {nav.map((item) => {
              const Icon = item.icon
              return (
                <DropdownMenuItem key={item.to} onClick={() => navigate({ to: item.to })}>
                  <Icon size={15} /> {t(`nav.${item.key}`)}
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            {ACCOUNT.map((item) => {
              const Icon = item.icon
              return (
                <DropdownMenuItem key={item.to} onClick={() => navigate({ to: item.to })}>
                  <Icon size={15} /> {t(`nav.${item.key}`)}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <Link to="/workspace" className="flex shrink-0 items-center gap-2 text-text">
          <span aria-hidden className="cs-logo-mark h-5 w-5" />
          <span className="text-ui font-semibold leading-none tracking-[-0.01em]">我的工作室</span>
        </Link>
        {canvasName && (
          <>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
            <span className="hidden max-w-[240px] truncate text-caption text-text-tertiary sm:inline">
              {canvasName}
            </span>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <QuotaBadge />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  )
}
