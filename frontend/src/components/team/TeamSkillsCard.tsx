import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Package, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { skillsApi, type SkillPackSummary } from '@/lib/api/onboarding'
import { teamsApi } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'

interface TeamSkillsCardProps {
  teamId: string
  editable: boolean
}

/**
 * 团队默认技能包。
 *
 * 成员会「继承」团队包，同时可以再叠加自己的包（并集）。这里改的是团队那一份，
 * 不改任何成员的个人选择——管理员调整团队规范，不该顺手抹掉成员自己的偏好。
 */
export function TeamSkillsCard({ teamId, editable }: TeamSkillsCardProps) {
  const { t } = useTranslation('team')
  const toast = useToast()
  const [packs, setPacks] = useState<SkillPackSummary[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [initial, setInitial] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [catalog, current] = await Promise.all([
        skillsApi.packs(),
        teamsApi.skills(teamId),
      ])
      setPacks(catalog.items)
      setSelected(current.pack_keys)
      setInitial(current.pack_keys)
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[team] skills', err)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback((key: string) => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    )
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await teamsApi.setSkills(teamId, selected)
      setInitial(selected)
      toast.success(t('settings.saved'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [teamId, selected, toast, t])

  const dirty = selected.length !== initial.length || selected.some((k) => !initial.includes(k))

  if (loading) {
    return (
      <Card className="flex items-center justify-center p-6">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
      </Card>
    )
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-col">
        <CardTitle className="flex items-center gap-1.5 text-ui">
          <Package size={14} className="text-accent-ink" />
          {t('settings.skills')}
        </CardTitle>
        <CardDescription className="mt-1">{t('settings.skills_hint')}</CardDescription>
      </div>

      <div className="grid max-h-[340px] gap-1.5 overflow-auto pr-1 sm:grid-cols-2">
        {packs.map((pack) => {
          const active = selected.includes(pack.key)
          return (
            <button
              key={pack.key}
              type="button"
              disabled={!editable}
              onClick={() => toggle(pack.key)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-[10px] border px-2.5 py-2 text-left transition-colors',
                active
                  ? 'border-accent-strong bg-accent-soft/40'
                  : 'border-border/70 bg-surface hover:border-border-strong',
                !editable && 'cursor-not-allowed opacity-70',
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-caption text-text">{pack.name}</span>
                <span className="truncate text-[10px] text-text-tertiary">
                  {pack.description || pack.category}
                </span>
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-text-tertiary">
                {pack.count}
              </span>
            </button>
          )
        })}
      </div>

      {editable && (
        <Button
          size="sm"
          className="self-start"
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
        >
          <Save size={13} /> {t('settings.save')}
        </Button>
      )}
    </Card>
  )
}
