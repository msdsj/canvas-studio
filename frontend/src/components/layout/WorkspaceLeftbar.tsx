import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PenSquare,
  LayoutGrid,
  Images,
  Wallet,
  Settings,
  ListChecks,
  Shield,
  ImagePlus,
  Upload,
} from 'lucide-react'
import { Link, useRouterState } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/use-auth'
import { Button } from '@/components/ui/button'
import { QuotaBadge } from './QuotaBadge'

interface NavItem {
  to: string
  label: string
  icon: typeof PenSquare
  adminOnly?: boolean
}

function useNavItems(): NavItem[] {
  const { t } = useTranslation('common')
  const { isAdmin } = useAuth()
  const items: NavItem[] = [
    { to: '/workspace', label: t('nav.workspace'), icon: PenSquare },
    { to: '/tasks', label: t('nav.tasks'), icon: ListChecks },
    { to: '/projects', label: t('nav.projects'), icon: LayoutGrid },
    { to: '/assets', label: t('nav.assets'), icon: Images },
    { to: '/usage', label: t('nav.usage'), icon: Wallet },
    { to: '/settings', label: t('nav.settings'), icon: Settings },
  ]
  if (isAdmin) items.push({ to: '/admin', label: t('nav.admin'), icon: Shield, adminOnly: true })
  return items
}

/** 通用左侧导航（非画布页面使用）。 */
export function AppSidebar() {
  const items = useNavItems()
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <nav className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-surface p-3">
      {items.map((item) => {
        const active = pathname === item.to || pathname.startsWith(`${item.to}/`)
        const Icon = item.icon
        return (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              active ? 'bg-brand-subtle text-brand-text' : 'text-text-secondary hover:bg-surface-hover'
            )}
          >
            <Icon size={18} />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

interface WorkspaceLeftbarProps {
  onAddImage?: () => void
  onUpload?: () => void
  collapsed?: boolean
}

/** 工作台左栏：项目切换 + 工具区 + 账户额度。 */
export function WorkspaceLeftbar({ onAddImage, onUpload, collapsed }: WorkspaceLeftbarProps) {
  const { t } = useTranslation('workspace')
  const items = useNavItems()

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.label}
              className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
            >
              <Icon size={18} />
            </Link>
          )
        })}
      </aside>
    )
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface p-3">
      <div>
        <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
          {t('leftbar.tools')}
        </div>
        <div className="flex flex-col gap-1">
          <ToolButton icon={<ImagePlus size={18} />} label={t('leftbar.add_image')} onClick={onAddImage} />
          <ToolButton icon={<Upload size={18} />} label={t('leftbar.upload')} onClick={onUpload} />
        </div>
      </div>

      <div>
        <div className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
          {t('leftbar.projects')}
        </div>
        <div className="flex flex-col gap-1">
          {items.map((item) => {
            const Icon = item.icon
            return (
              <Link
                key={item.to}
                to={item.to}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover"
              >
                <Icon size={18} />
                {item.label}
              </Link>
            )
          })}
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
        <span className="px-2 text-xs text-text-tertiary">{t('leftbar.account')}</span>
        <div className="px-2">
          <QuotaBadge />
        </div>
      </div>
    </aside>
  )
}

function ToolButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="justify-start gap-3 px-3 text-text-secondary"
    >
      {icon}
      <span className="text-sm">{label}</span>
    </Button>
  )
}
