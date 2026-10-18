import { Check, Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLanguage } from '@/hooks/use-language'
import { cn } from '@/lib/utils'
import type { SupportedLanguage } from '@/i18n'

/** 语言切换（`compact` 为 28px 图标按钮，用于与通知/主题并排成一行）。 */
export function LocaleToggle({ compact = false }: { compact?: boolean }) {
  const { language, setLanguage, options } = useLanguage()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="language"
          title="切换语言"
          className={cn(
            'flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text',
            compact ? 'h-7 w-7' : 'h-9 w-9'
          )}
        >
          <Languages size={compact ? 15 : 18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((lang: SupportedLanguage) => (
          <DropdownMenuItem key={lang} onClick={() => setLanguage(lang)}>
            {lang === 'zh-CN' ? '简体中文' : 'English'}
            {language === lang && <Check size={14} className="ml-auto text-brand-text" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
