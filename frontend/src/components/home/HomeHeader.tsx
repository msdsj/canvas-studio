import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { Avatar } from '@/components/ui/avatar'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { LocaleToggle } from '@/components/layout/LocaleToggle'
import type { User } from '@/types/models'
import { BrandMark } from '@/components/brand/BrandMark'

interface HomeHeaderProps {
  user: Pick<User, 'display_name' | 'email'> | null
  onLogin: () => void
  onRegister: () => void
}

/**
 * 首页顶栏：品牌 + 锚点导航 + 主题/语言 + 登录态入口。
 * 不做吸顶：首页主角是输入框，顶栏跟着首屏走即可，滚到下方时不再遮挡内容。
 */
export function HomeHeader({ user, onLogin, onRegister }: HomeHeaderProps) {
  const { t } = useTranslation('home')

  return (
    <header className="relative z-30">
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between gap-2 px-4 sm:px-8">
        <Link to="/" className="flex min-w-0 items-center gap-2.5 text-text">
          <BrandMark className="h-7 w-7" />
          <span className="truncate text-ui font-semibold tracking-[-0.02em]">{t('brand.product')}</span>
          <span className="ml-1 hidden rounded-full border border-border px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary md:inline">
            {t('brand.tag')}
          </span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex">
          {(['highlights', 'gallery', 'how', 'faq'] as const).map((key) => (
            <a
              key={key}
              href={`#${key}`}
              className="rounded-full px-3 py-1.5 text-caption text-text-secondary transition-colors hover:bg-surface/70 hover:text-text"
            >
              {t(`nav.${key}`)}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <LocaleToggle />
          <ThemeToggle />
          {user ? (
            <>
              <Link
                to="/workspace"
                className="group ml-1 inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-3.5 text-caption font-semibold text-text-inverse shadow-sheet transition-[filter] hover:brightness-110 sm:px-4"
              >
                <span className="hidden sm:inline">{t('nav.enter')}</span>
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <span className="ml-1 hidden rounded-full ring-1 ring-border sm:inline-flex">
                <Avatar name={user.display_name || user.email} size={30} />
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onLogin}
                className="hidden h-9 items-center rounded-full px-3.5 text-caption font-medium text-text-secondary transition-colors hover:bg-surface/70 hover:text-text sm:inline-flex"
              >
                {t('nav.login')}
              </button>
              <button
                type="button"
                onClick={onRegister}
                className="ml-1 inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-3.5 text-caption font-semibold text-text-inverse shadow-sheet transition-[filter] hover:brightness-110 sm:px-4"
              >
                {t('nav.start')}
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
