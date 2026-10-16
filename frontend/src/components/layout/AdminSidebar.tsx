import { Link, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AdminNavItem {
  to: string
  key: string
}

const ITEMS: AdminNavItem[] = [
  { to: '/admin', key: 'overview' },
  { to: '/admin/users', key: 'users' },
  { to: '/admin/pool', key: 'pool' },
  { to: '/admin/config', key: 'config' },
  { to: '/admin/invites', key: 'invites' },
  { to: '/admin/announcements', key: 'announcements' },
  { to: '/admin/logs', key: 'logs' },
]

/** 管理后台左侧导航（240px）。 */
export function AdminSidebar() {
  const { t } = useTranslation('admin')
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-border bg-surface p-3">
      <Link
        to="/workspace"
        className="mb-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
      >
        <ArrowLeft size={16} /> {t('title')}
      </Link>
      {ITEMS.map((item) => {
        const active = pathname === item.to
        return (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              'rounded-md px-3 py-2 text-sm transition-colors',
              active ? 'bg-brand-subtle font-medium text-brand-text' : 'text-text-secondary hover:bg-surface-hover'
            )}
          >
            {t(`sidebar.${item.key}`)}
          </Link>
        )
      })}
    </aside>
  )
}
