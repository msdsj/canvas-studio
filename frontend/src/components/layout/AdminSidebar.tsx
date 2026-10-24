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
  { to: '/admin/pro-codes', key: 'pro_codes' },
  { to: '/admin/announcements', key: 'announcements' },
  { to: '/admin/logs', key: 'logs' },
]

/** 管理后台左侧导航（216px）。 */
export function AdminSidebar() {
  const { t } = useTranslation('admin')
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  return (
    <aside className="m-2 flex w-[216px] shrink-0 flex-col gap-1 rounded-[16px] bg-surface p-3 shadow-sheet">
      <Link
        to="/workspace"
        className="mb-2 flex items-center gap-2 rounded-[10px] px-3 py-2 text-ui text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
      >
        <ArrowLeft size={16} /> {t('title')}
      </Link>
      {ITEMS.map((item) => {
        const active = pathname === item.to
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex flex-col gap-0.5 rounded-[10px] px-3 py-2 transition-colors duration-[160ms]',
              active
                ? 'bg-bg-subtle text-text'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text',
            )}
          >
            {/* 激活项左侧一道 2px 青柠：这是这一屏唯一的信号色，够醒目又不喧宾夺主 */}
            {active && (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent-strong"
              />
            )}
            <span className={cn('text-ui', active && 'font-semibold')}>{t(`sidebar.${item.key}`)}</span>
            {/* 常驻的一行说明：后台大多是专有名词，只给 hover 提示等于没人看得到 */}
            <span className={cn('text-[10px] leading-snug', active ? 'text-text-secondary' : 'text-text-faint')}>
              {t(`sidebar_hints.${item.key}`)}
            </span>
          </Link>
        )
      })}
    </aside>
  )
}
