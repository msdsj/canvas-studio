import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { SkillPackSummary } from '@/lib/api/onboarding'

interface SkillPackCardProps {
  pack: SkillPackSummary
  active: boolean
  fromTeam: boolean
  onToggle: (key: string) => void
}

/**
 * 技能包卡片。
 *
 * v3 改动：
 * - 标题从 13px 提到 14px、描述从 11px 提到 13px：原来整张卡小到要凑近看；
 * - 右下角那行 10px 的「已启用 / 未启用」换成**真正的开关**——
 *   改造前那行字既不可点、也不像开关，用户根本不知道技能包能被启用；
 * - 整卡可点（点卡片任意空白处切换），但开关本身受控，不会冒泡导致双切。
 */
export function SkillPackCard({ pack, active, fromTeam, onToggle }: SkillPackCardProps) {
  const { t } = useTranslation('onboarding')

  return (
    <Card
      interactive
      onClick={() => onToggle(pack.key)}
      className={cn(
        'flex flex-col gap-2 p-4 transition-colors',
        active && 'border-accent-strong bg-accent-soft/30',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-ui font-semibold leading-snug text-text">{pack.name}</h3>
        <div className="flex shrink-0 items-center gap-2">
          {fromTeam && (
            <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-micro text-accent-ink">
              <Users size={10} />
              {t('skills.from_team')}
            </span>
          )}
          <Switch
            checked={active}
            onCheckedChange={() => onToggle(pack.key)}
            onClick={(event) => event.stopPropagation()}
            aria-label={pack.name}
          />
        </div>
      </div>

      <p className="line-clamp-3 text-caption leading-relaxed text-text-secondary">
        {pack.description || pack.category}
      </p>

      <p className="mt-auto pt-1 text-micro tabular-nums text-text-tertiary">
        {t('skills.count', { count: pack.count })}
      </p>
    </Card>
  )
}
