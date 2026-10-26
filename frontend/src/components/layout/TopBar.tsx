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
import { BrandMark } from '@/components/brand/BrandMark'
import { cn } from '@/lib/utils'

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
 *
 * v3 改动：**导航不再只藏在左上角一个九宫格图标里**。
 * 改造前 8 个页面的主导航全部收在一个 15px 的下拉里——用户在任何一个
 * 内容页都看不见自己还能去哪。现在 ≥1280 直接显示水平主导航，
 * 1280 以下才收进下拉（触发按钮同时从 15px 放大到 18px，不再是"猜").
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

  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`)

  return (
    <header className="mx-2.5 mt-2.5 flex h-11 shrink-0 items-center justify-between gap-3 rounded-[12px] border border-border-faint bg-surface px-2 shadow-xs">
      <div className="flex min-w-0 items-center gap-1.5">
        {/* 窄屏才出现的下拉入口 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('nav.workspace')}
              className="flex h-8 w-8 items-center justify-center rounded-[8px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text xl:hidden"
            >
              <LayoutGrid size={18} />
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

        <Link to="/" className="flex shrink-0 items-center gap-2 text-text">
          <BrandMark className="h-5 w-5" />
          {/* 手机上只留图标：文字与额度徽标会在 390px 宽里叠字 */}
          <span className="hidden text-ui font-semibold leading-none tracking-[-0.01em] sm:inline">
            {t('nav.studio')}
          </span>
        </Link>

        {/* 宽屏主导航：把"还能去哪"直接摆在眼前 */}
        <nav className="ml-3 hidden items-center gap-1 xl:flex">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} active={isActive(item.to)}>
              {t(`nav.${item.key}`)}
            </NavLink>
          ))}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {ACCOUNT.map((item) => (
            <NavLink key={item.to} to={item.to} active={isActive(item.to)}>
              {t(`nav.${item.key}`)}
            </NavLink>
          ))}
        </nav>

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

/** Active navigation uses the shared brand blue for a clear, consistent location cue. */
function NavLink({
  to,
  active,
  children,
}: {
  to: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={cn(
        'relative flex h-8 items-center rounded-[8px] px-2.5 text-ui font-medium transition-colors duration-[160ms]',
        active ? 'text-text' : 'text-text-secondary hover:text-text',
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-2 -bottom-[7px] h-[2px] rounded-full bg-brand transition-opacity duration-[160ms]',
          active ? 'opacity-100' : 'opacity-0',
        )}
      />
    </Link>
  )
}
