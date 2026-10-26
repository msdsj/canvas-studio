import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useRouterState } from '@tanstack/react-router'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { UserMenu } from './UserMenu'
import { AdminSidebar } from './AdminSidebar'
import { QuotaBadge } from './QuotaBadge'
import { PageShell } from './PageShell'

interface AdminShellProps {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}

/**
 * 管理后台壳：侧栏 + 顶栏 + 内容区。
 *
 * v3 改动：**不再自己写一套页头**。
 * 改造前后台是全站第六套壳——标题字号、容器宽度、gutter 都和普通页面不一样，
 * 于是"从后台回到产品页"时会有一次明显的视觉跳变。现在内部直接复用
 * `PageShell`，页头结构、gutter、宽度与其它 20 个页面完全同源。
 */
export function AdminShell({ title, description, actions, children }: AdminShellProps) {
  const { t } = useTranslation('admin')
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // 路由段是 kebab-case（/admin/pro-codes），文案键是 snake_case（sidebar.pro_codes）
  const segment = pathname.split('/').filter(Boolean)[1]?.replace(/-/g, '_')

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="mx-2.5 mt-2.5 flex h-11 shrink-0 items-center justify-between gap-3 rounded-[12px] border border-border-faint bg-surface px-2 shadow-xs">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              to="/workspace"
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-ui font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <ArrowLeft size={16} />
              <span className="hidden sm:inline">{t('back_to_studio')}</span>
            </Link>
            <span aria-hidden className="h-4 w-px bg-border" />
            <span className="flex min-w-0 items-center gap-1 text-ui text-text-tertiary">
              <span className="truncate">{t('title')}</span>
              {segment && (
                <>
                  <ChevronRight size={14} className="shrink-0" />
                  <span className="truncate text-text-secondary">
                    {t(`sidebar.${segment}`)}
                  </span>
                </>
              )}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <QuotaBadge />
            <UserMenu />
          </div>
        </header>

        <div className="min-h-0 flex-1">
          <PageShell title={title} description={description} actions={actions} width="wide">
            {children}
          </PageShell>
        </div>
      </div>
    </div>
  )
}
