import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useCanvasStore } from '@/stores/canvas'
import { QuotaBadge } from './QuotaBadge'
import { NotificationBell } from './NotificationBell'
import { LocaleToggle } from './LocaleToggle'
import { ThemeToggle } from './ThemeToggle'
import { UserMenu } from './UserMenu'

/** 全局顶栏：Logo + 项目名 | 额度 · 通知 · 语言 · 主题 · 头像。 */
export function TopBar() {
  const { t } = useTranslation('common')
  const canvasName = useCanvasStore((s) => s.canvas?.name)

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Link to="/workspace" className="flex items-center gap-2 text-text">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-text-inverse">
            <Sparkles size={16} />
          </span>
          <span className="text-md font-semibold">{t('app_name')}</span>
        </Link>
        {canvasName && (
          <span className="hidden max-w-[240px] truncate border-l border-border pl-3 text-sm text-text-secondary sm:inline">
            {canvasName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <QuotaBadge />
        <NotificationBell />
        <LocaleToggle />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  )
}
