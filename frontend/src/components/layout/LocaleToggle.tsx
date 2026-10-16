import { Languages } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLanguage } from '@/hooks/use-language'
import type { SupportedLanguage } from '@/i18n'

/** 语言切换。 */
export function LocaleToggle() {
  const { language, setLanguage, options } = useLanguage()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="language">
          <Languages size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((lang: SupportedLanguage) => (
          <DropdownMenuItem key={lang} onClick={() => setLanguage(lang)}>
            {lang === 'zh-CN' ? '简体中文' : 'English'}
            {language === lang && <span className="ml-auto text-brand">•</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
