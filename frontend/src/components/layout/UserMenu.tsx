import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import {
  Check,
  Languages,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Settings,
  Shield,
  Sun,
  User as UserIcon,
  Users,
  Wallet,
} from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuth } from '@/hooks/use-auth'
import { useLanguage } from '@/hooks/use-language'
import { useTheme } from '@/hooks/use-theme'
import { useQuotaStore } from '@/stores/quota'
import type { SupportedLanguage } from '@/i18n'
import type { ThemeMode } from '@/stores/theme'

/**
 * 用户菜单：资料 / 管理后台 / 额度 · 语言 · 主题 · 登出。
 *
 * 语言与主题从顶栏搬到这里——它们是「设一次就不动」的偏好，
 * 和头像同属「关于我」的范畴，占着顶栏会把创作额度和通知挤掉。
 */
export function UserMenu({
  compact = false,
  trigger,
}: {
  compact?: boolean
  /**
   * 自定义触发器（可选）。
   *
   * 身份条里头像已经和昵称排在一起，不能再额外渲染一颗头像——
   * 那会出现两个「我」（截图里就是左边"管"、右边"A"并排）。
   * 传一个 button 进来，菜单挂到它上面，全站仍然只有一处账号入口。
   */
  trigger?: ReactNode
}) {
  const { t } = useTranslation('common')
  const { user, isAdmin, logout } = useAuth()
  const navigate = useNavigate()
  const { language, setLanguage, options } = useLanguage()
  const { mode, setMode } = useTheme()

  const handleLogout = async () => {
    await logout()
    useQuotaStore.getState().reset()
    // 退出后回首页（登录页已下线，登录走全局弹窗）
    void navigate({ to: '/' })
  }

  const themeOptions: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
    { id: 'light', label: t('theme.light'), icon: Sun },
    { id: 'dark', label: t('theme.dark'), icon: Moon },
    { id: 'system', label: t('theme.system'), icon: Monitor },
  ]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button type="button" aria-label="user menu" className="rounded-full focus-visible:outline-none">
            <Avatar name={user?.email} size={compact ? 26 : 32} />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="truncate text-ui text-text">{user?.display_name || user?.email}</span>
            <span className="truncate text-caption text-text-tertiary">{user?.email}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ to: '/settings' })}>
          <UserIcon size={16} /> {t('nav.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate({ to: '/usage' })}>
          <Wallet size={16} /> {t('nav.usage')}
        </DropdownMenuItem>
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            {/* 超管入口只放在头像里：普通用户完全不知道有这个页面 */}
            <DropdownMenuItem onClick={() => navigate({ to: '/admin' })}>
              <Shield size={16} /> {t('nav.admin')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate({ to: '/admin/users' })}>
              <Users size={16} /> 用户管理
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate({ to: '/admin/pool' })}>
              <Wallet size={16} /> 额度与兑换码
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate({ to: '/admin/config' })}>
              <Settings size={16} /> 系统配置
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate({ to: '/admin/logs' })}>
              <ScrollText size={16} /> 操作日志
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuSeparator />

        <DropdownMenuLabel className="flex items-center gap-1.5 text-caption text-text-tertiary">
          <Languages size={13} /> {t('language.label')}
        </DropdownMenuLabel>
        {options.map((lang: SupportedLanguage) => (
          <DropdownMenuItem key={lang} onClick={() => setLanguage(lang)}>
            <span className="flex-1">{lang === 'zh-CN' ? '简体中文' : 'English'}</span>
            {language === lang && <Check size={14} className="text-brand" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />

        <DropdownMenuLabel className="flex items-center gap-1.5 text-caption text-text-tertiary">
          <Settings size={13} /> {t('theme.label')}
        </DropdownMenuLabel>
        {/*
         * 菜单项随下拉一起瞬间卸载，拿不到稳定 rect：传 null 让扩散从视口中心起。
         * ThemeToggle 才是精确原点的那条路径。
         */}
        {themeOptions.map((item) => {
          const Icon = item.icon
          return (
            <DropdownMenuItem key={item.id} onClick={() => setMode(item.id, null)}>
              <Icon size={16} />
              <span className="flex-1">{item.label}</span>
              {mode === item.id && <Check size={14} className="text-brand" />}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onClick={handleLogout}>
          <LogOut size={16} /> {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
