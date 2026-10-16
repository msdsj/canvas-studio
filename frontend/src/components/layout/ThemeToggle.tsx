import { useTranslation } from 'react-i18next'
import { Moon, Sun, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme } from '@/hooks/use-theme'

/** 主题切换（浅色 / 深色 / 跟随系统）。 */
export function ThemeToggle() {
  const { t } = useTranslation('common')
  const { mode, setMode } = useTheme()

  const next = mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light'
  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('theme.toggle')} onClick={() => setMode(next)}>
          <Icon size={18} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t(`theme.${mode}`)}</TooltipContent>
    </Tooltip>
  )
}
