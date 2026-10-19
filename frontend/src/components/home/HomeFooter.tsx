import { useTranslation } from 'react-i18next'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { LocaleToggle } from '@/components/layout/LocaleToggle'

interface FooterColumn {
  title: string
  links: Array<{ label: string; href: string }>
}

/** 首页页脚：品牌 + 站内锚点分栏 + 主题 / 语言（滚到底的人不必再回到顶部切换）。 */
export function HomeFooter() {
  const { t } = useTranslation('home')
  const columns = t('footer.columns', { returnObjects: true }) as FooterColumn[]

  return (
    <footer className="relative z-10 border-t border-border-faint bg-surface/40 backdrop-blur">
      <div className="mx-auto grid w-full max-w-[1240px] gap-10 px-4 py-12 sm:px-8 md:grid-cols-[1.3fr_2fr]">
        <div>
          <div className="flex items-center gap-2.5 text-text">
            <span aria-hidden className="cs-logo-mark h-7 w-7" />
            <span className="text-ui font-semibold tracking-[-0.02em]">{t('brand.product')}</span>
          </div>
          <p className="mt-3 max-w-[320px] text-caption leading-relaxed text-text-tertiary">{t('footer.about')}</p>
          <div className="mt-4 flex items-center gap-1">
            <LocaleToggle />
            <ThemeToggle />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {columns.map((column) => (
            <div key={column.title}>
              <p className="text-micro font-semibold uppercase tracking-[0.12em] text-text-tertiary">{column.title}</p>
              <ul className="mt-3 flex flex-col gap-2">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-caption text-text-secondary transition-colors hover:text-text"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-2 border-t border-border-faint px-4 py-5 text-micro text-text-faint sm:px-8">
        <span>{t('footer.rights', { year: new Date().getFullYear() })}</span>
        <span>{t('footer.slogan')}</span>
      </div>
    </footer>
  )
}
