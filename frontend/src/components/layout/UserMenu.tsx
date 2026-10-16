import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { LogOut, Settings, Shield, User as UserIcon } from 'lucide-react'
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
import { useQuotaStore } from '@/stores/quota'

/** 用户菜单：资料 / 管理后台 / 登出。 */
export function UserMenu() {
  const { t } = useTranslation('common')
  const { user, isAdmin, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = async () => {
    await logout()
    useQuotaStore.getState().reset()
    void navigate({ to: '/login' })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="user menu" className="rounded-full focus-visible:outline-none">
          <Avatar name={user?.email} size={32} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="truncate text-sm text-text">{user?.display_name || user?.email}</span>
            <span className="truncate text-xs text-text-tertiary">{user?.email}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate({ to: '/settings' })}>
          <UserIcon size={16} /> {t('nav.settings')}
        </DropdownMenuItem>
        {isAdmin && (
          <DropdownMenuItem onClick={() => navigate({ to: '/admin' })}>
            <Shield size={16} /> {t('nav.admin')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => navigate({ to: '/usage' })}>
          <Settings size={16} /> {t('nav.usage')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onClick={handleLogout}>
          <LogOut size={16} /> {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
