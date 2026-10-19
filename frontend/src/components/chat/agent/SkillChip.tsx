import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Wand2 } from 'lucide-react'
import { aiApi } from '@/lib/api/ai'
import { cn } from '@/lib/utils'

/**
 * 技能 id → 名称。
 *
 * compose 结果只带 `skill_id`；名称在技能库接口里。整个会话只拉一次并缓存在模块级，
 * 失败就退回显示 id——技能标签是辅助信息，不值得为它报错。
 */
let skillNamesPromise: Promise<Record<string, string>> | null = null

function loadSkillNames(): Promise<Record<string, string>> {
  if (!skillNamesPromise) {
    skillNamesPromise = aiApi
      .skills()
      .then((data) => {
        const map: Record<string, string> = {}
        data.items.forEach((item) => {
          map[item.id] = item.name
        })
        return map
      })
      .catch(() => {
        skillNamesPromise = null
        return {}
      })
  }
  return skillNamesPromise
}

export function useSkillName(skillId?: string | null, fallbackName?: string | null): string | null {
  const [name, setName] = useState<string | null>(fallbackName || null)
  useEffect(() => {
    if (fallbackName) {
      setName(fallbackName)
      return
    }
    if (!skillId) {
      setName(null)
      return
    }
    let alive = true
    void loadSkillNames().then((map) => {
      if (alive) setName(map[skillId] ?? skillId)
    })
    return () => {
      alive = false
    }
  }, [skillId, fallbackName])
  return name
}

interface SkillChipProps {
  skillId?: string | null
  /** 已知名称（skill_run 自带）时直接用，不查表 */
  name?: string | null
  className?: string
}

/** 「使用技能 · xxx」：告诉用户这次出图套用了哪套设计方法，而不是黑箱。 */
export function SkillChip({ skillId, name, className }: SkillChipProps) {
  const { t } = useTranslation('agent')
  const label = useSkillName(skillId, name)
  if (!label) return null
  return (
    <span
      title={t('skill.chip', { name: label })}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-micro font-medium text-accent-ink ring-1 ring-inset ring-accent-strong/30',
        className
      )}
    >
      <Wand2 size={11} className="shrink-0" />
      <span className="shrink-0 opacity-75">{t('skill.using')}</span>
      <span className="shrink-0 opacity-50">·</span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
