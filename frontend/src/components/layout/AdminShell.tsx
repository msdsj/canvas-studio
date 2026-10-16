import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { UserMenu } from './UserMenu'
import { AdminSidebar } from './AdminSidebar'

interface AdminShellProps {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}

/** 管理后台壳：侧栏 + 顶部条 + 内容区。 */
export function AdminShell({ title, description, actions, children }: AdminShellProps) {
  const { t } = useTranslation('admin')
  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
          <span className="text-md font-semibold text-text">{t('title')}</span>
          <UserMenu />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-text">{title}</h1>
              {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
