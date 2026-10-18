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

/**
 * 导航分两组：**创作**是日常动作，**管理**是低频事务。
 * 混在一起平铺会让工作台看起来像个后台管理系统——而这里的主体是画布。
 */
function useNavGroups(): { creation: NavItem[]; management: NavItem[] } {
  const { t } = useTranslation('common')
  const { isAdmin } = useAuth()
  const creation: NavItem[] = [
    { to: '/workspace', label: t('nav.workspace'), icon: PenSquare },
    { to: '/assets', label: t('nav.assets'), icon: Images },
    { to: '/projects', label: t('nav.projects'), icon: LayoutGrid },
    { to: '/tasks', label: t('nav.tasks'), icon: ListChecks },
  ]
  const management: NavItem[] = [
    { to: '/usage', label: t('nav.usage'), icon: Wallet },
    { to: '/settings', label: t('nav.settings'), icon: Settings },
  ]
  if (isAdmin) management.push({ to: '/admin', label: t('nav.admin'), icon: Shield, adminOnly: true })
  return { creation, management }
}

function useActivePath() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (to: string) => pathname === to || pathname.startsWith(`${to}/`)
}

/** 通用左侧导航（非画布页面使用）。 */
export function AppSidebar() {
  const { creation, management } = useNavGroups()
  const isActive = useActivePath()

  const renderItem = (item: NavItem) => {
    const Icon = item.icon
    return (
      <Link
        key={item.to}
        to={item.to}
        className={cn(
          'flex items-center gap-3 rounded-[10px] px-3 py-2 text-ui transition-colors',
          isActive(item.to)
            ? 'bg-brand-subtle text-brand-text'
            : 'text-text-secondary hover:bg-surface-hover'
        )}
      >
        <Icon size={20} />
        {item.label}
      </Link>
    )
  }

  return (
    <nav className="m-2 flex w-[216px] shrink-0 flex-col gap-1 rounded-[16px] bg-surface p-3 shadow-sheet">
      {creation.map(renderItem)}
      <div className="mt-auto flex flex-col gap-1 pt-6">{management.map(renderItem)}</div>
    </nav>
  )
}

interface WorkspaceLeftbarProps {
  onAddImage?: () => void
  onUpload?: () => void
  /** 图层面板（类 Figma 图层管理） */
  layersSlot?: ReactNode
  collapsed?: boolean
}

/** 工作台左栏：创作工具 + 图层 + 导航（创作 / 管理分组）+ 账户额度。 */
export function WorkspaceLeftbar({ onAddImage, onUpload, layersSlot, collapsed }: WorkspaceLeftbarProps) {
  const { t } = useTranslation('workspace')
  const { creation, management } = useNavGroups()
  const isActive = useActivePath()

  const iconLink = (item: NavItem) => {
    const Icon = item.icon
    const active = isActive(item.to)
    return (
      <Link
        key={item.to}
        to={item.to}
        title={item.label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-[10px] transition-colors',
          active
            ? 'bg-brand-subtle text-brand-text'
            : 'text-text-secondary hover:bg-surface-hover hover:text-text'
        )}
      >
        <Icon size={20} />
      </Link>
    )
  }

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-1 rounded-[14px] bg-surface py-3 shadow-sheet">
        {creation.map(iconLink)}
        {/* 管理组靠留白推到栏底，不用分割线 */}
        <div className="mt-auto flex flex-col items-center gap-1 pt-4">{management.map(iconLink)}</div>
      </aside>
    )
  }

  const rowLink = (item: NavItem) => {
    const Icon = item.icon
    const active = isActive(item.to)
    return (
      <Link
        key={item.to}
        to={item.to}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-[10px] px-3 py-2 text-ui transition-colors',
          active ? 'bg-brand-subtle text-brand-text' : 'text-text-secondary hover:bg-surface-hover'
        )}
      >
        <Icon size={20} />
        {item.label}
      </Link>
    )
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto rounded-[14px] bg-surface p-3 shadow-sheet">
      <div>
        <div className="mb-1 px-2 text-caption font-medium text-text-tertiary">
          {t('leftbar.tools')}
        </div>
        <div className="flex flex-col gap-1">
          <ToolButton icon={<ImagePlus size={20} />} label={t('leftbar.add_image')} onClick={onAddImage} />
          <ToolButton icon={<Upload size={20} />} label={t('leftbar.upload')} onClick={onUpload} />
        </div>
      </div>

      {layersSlot && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-1 px-2 text-caption font-medium text-text-tertiary">
            {t('leftbar.layers', { defaultValue: '图层' })}
          </div>
          {layersSlot}
        </div>
      )}

      <div className="flex flex-col gap-1">{creation.map(rowLink)}</div>

      <div className="mt-auto flex flex-col gap-3 pt-6">
        <div className="flex flex-col gap-1">{management.map(rowLink)}</div>
        <div className="flex flex-col gap-2 px-2">
          <span className="text-caption text-text-tertiary">{t('leftbar.account')}</span>
          <QuotaBadge />
        </div>
      </div>
    </aside>
  )
}

function ToolButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick?: () => void }) {
  return (
    <Button variant="ghost" onClick={onClick} className="justify-start gap-3 px-3 text-text-secondary">
      {icon}
      <span className="text-ui">{label}</span>
    </Button>
  )
}
