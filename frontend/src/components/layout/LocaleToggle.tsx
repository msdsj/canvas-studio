import { Check, Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLanguage } from '@/hooks/use-language'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

/** 语言切换（`compact` 为 28px 图标按钮，用于与通知/主题并排成一行）。 */
export function LocaleToggle({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, options } = useLanguage()
  const { t } = useTranslation('common')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('language.switch')}
          title={t('language.switch')}
          className={cn(
            'flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text',
            compact ? 'h-7 w-7' : 'h-9 w-9'
          )}
        >
          <Languages size={compact ? 15 : 18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((item) => (
          <DropdownMenuItem key={item.code} onClick={() => setLanguage(item.code)}>
            <span lang={item.code}>{item.nativeName}</span>
            {language === item.code && <Check size={14} className="ml-auto text-brand-text" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
