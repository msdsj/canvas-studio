import { useCallback } from 'react'
import { Building2, Check, ChevronDown, User } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { cn } from '@/lib/utils'

/**
 * 空间切换器：个人空间 ↔ 某个团队。
 *
 * 放在身份区而不是设置页：这是「我在哪儿干活」这种每秒都在用的上下文，
 * 埋进设置里会让人反复怀疑自己刚才生成的图到底进了哪个空间。
 *
 * 只有一个团队时也照样显示（而不是退化成静态文字）：
 * 用户需要能切回个人空间，否则找不到自己的旧内容。
 */
export function TeamSwitcher({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation('team')
  const toast = useToast()
  const teams = useTeamStore((s) => s.teams)
  const activeId = useTeamStore((s) => s.activeId)
  const switchTo = useTeamStore((s) => s.switchTo)

  const active = teams.find((team) => team.id === activeId) ?? null
  const label = active?.name ?? t('space.personal')

  const select = useCallback(
    async (teamId: string | null) => {
      if (teamId === activeId) return
      try {
        await switchTo(teamId)
      } catch (err) {
        toast.error(errorMessage(err))
      }
    },
    [activeId, switchTo, toast],
  )

  if (teams.length === 0) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={t('space.switch')}
          title={`${t('space.label')}：${label}`}
          className={cn(
            'flex items-center gap-1.5 rounded-full border border-border/70 bg-surface px-2 py-1 text-[11px] text-text-secondary transition-colors hover:border-border-strong hover:text-text',
            compact && 'px-1.5',
          )}
        >
          {active ? (
            <Building2 size={12} className="shrink-0 text-accent-ink" />
          ) : (
            <User size={12} className="shrink-0 text-text-tertiary" />
          )}
          <span className="max-w-[110px] truncate">{label}</span>
          <ChevronDown size={11} className="shrink-0 text-text-tertiary" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[200px] rounded-[12px] border border-border/70 bg-surface p-1 shadow-lift"
        >
          <DropdownMenu.Label className="px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
            {t('space.switch')}
          </DropdownMenu.Label>

          <DropdownMenu.Item
            onSelect={() => void select(null)}
            className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-caption text-text outline-none data-[highlighted]:bg-surface-hover"
          >
            <User size={13} className="text-text-tertiary" />
            <span className="flex-1">{t('space.personal')}</span>
            {activeId === null && <Check size={12} className="text-accent-ink" />}
          </DropdownMenu.Item>

          <DropdownMenu.Separator className="my-1 h-px bg-border/60" />

          {teams.map((team) => (
            <DropdownMenu.Item
              key={team.id}
              onSelect={() => void select(team.id)}
              className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-caption text-text outline-none data-[highlighted]:bg-surface-hover"
            >
              <Building2 size={13} className="text-accent-ink" />
              <span className="flex-1 truncate">{team.name}</span>
              <span className="shrink-0 text-[10px] text-text-tertiary">
                {t(`role.${team.role}`)}
              </span>
              {team.id === activeId && <Check size={12} className="text-accent-ink" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
