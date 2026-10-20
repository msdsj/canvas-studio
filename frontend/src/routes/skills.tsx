import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Loader2, Package, Save, Search, Sparkles } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import {
  skillsApi,
  type SkillPackItem,
  type SkillPackSummary,
} from '@/lib/api/onboarding'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/skills')({
  component: SkillsPage,
})

type Tab = 'packs' | 'items'

/**
 * 我的技能。
 *
 * 两个维度、两套开关，刻意分开：
 * - **技能包**（粗粒度）：「电商详情页」「国风海报」这类整套启用/停用；
 * - **单条技能**（细粒度）：不要某一两条具体风格时单独关掉。
 *
 * 团队包在这里是只读的：成员可以说「我不用这条」，但不能把团队的规范整体删掉
 * （那会影响别人）。所以团队包只显示来源，不提供开关。
 */
function SkillsPage() {
  const { t } = useTranslation('onboarding')
  const toast = useToast()

  const [tab, setTab] = useState<Tab>('packs')
  const [packs, setPacks] = useState<SkillPackSummary[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [initial, setInitial] = useState<string[]>([])
  const [items, setItems] = useState<SkillPackItem[]>([])
  const [teamPacks, setTeamPacks] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyItem, setBusyItem] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [catalog, mine] = await Promise.all([skillsApi.packs(), skillsApi.mine()])
      setPacks(catalog.items)
      setSelected(mine.personal_packs)
      setInitial(mine.personal_packs)
      setItems(mine.items)
      setTeamPacks(mine.team_packs)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  const togglePack = useCallback((key: string) => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
    )
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await skillsApi.setMine(selected)
      setInitial(selected)
      await load()
      toast.success(t('skills.saved'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [selected, load, toast, t])

  const toggleItem = useCallback(
    async (item: SkillPackItem, enabled: boolean) => {
      setBusyItem(item.id)
      try {
        await skillsApi.toggle(item.id, enabled)
        setItems((prev) =>
          enabled
            ? prev.some((row) => row.id === item.id)
              ? prev
              : [...prev, item]
            : prev.filter((row) => row.id !== item.id),
        )
      } catch (err) {
        toast.error(errorMessage(err))
      } finally {
        setBusyItem(null)
      }
    },
    [toast],
  )

  const dirty = useMemo(
    () => selected.length !== initial.length || selected.some((key) => !initial.includes(key)),
    [selected, initial],
  )

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q) ||
        item.tags.some((tag) => tag.toLowerCase().includes(q)),
    )
  }, [items, query])

  return (
    <ProtectedRoute>
      <AppShell>
        <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-auto p-6">
          <header className="flex flex-col gap-1">
            <h1 className="flex items-center gap-2 text-h2 font-semibold tracking-[-0.01em] text-text">
              <Sparkles size={18} className="text-accent-ink" />
              {t('skills.title')}
            </h1>
            <p className="max-w-[62ch] text-caption leading-relaxed text-text-secondary">
              {t('skills.subtitle')}
            </p>
          </header>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full bg-bg-subtle p-1">
              {(['packs', 'items'] as Tab[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={cn(
                    'rounded-full px-3 py-1 text-caption transition-colors',
                    tab === key
                      ? 'bg-surface text-text shadow-xs'
                      : 'text-text-tertiary hover:text-text-secondary',
                  )}
                >
                  {key === 'packs' ? t('skills.tab_packs') : t('skills.tab_items')}
                </button>
              ))}
            </div>

            {teamPacks.length > 0 && (
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] text-accent-ink">
                {t('skills.from_team')} · {teamPacks.length}
              </span>
            )}

            {tab === 'items' && (
              <label className="relative ml-auto flex w-56 items-center">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2.5 text-text-tertiary"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('skills.search_placeholder')}
                  className="h-8 pl-7 text-caption"
                />
              </label>
            )}
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 size={18} className="animate-spin text-text-tertiary" />
            </div>
          ) : tab === 'packs' ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {packs.map((pack) => {
                  const active = selected.includes(pack.key)
                  const fromTeam = teamPacks.includes(pack.key)
                  return (
                    <Card
                      key={pack.key}
                      interactive
                      onClick={() => togglePack(pack.key)}
                      className={cn(
                        'flex flex-col gap-1 p-3 transition-colors',
                        active && 'border-accent-strong bg-accent-soft/30',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-caption">{pack.name}</CardTitle>
                        {fromTeam && (
                          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent-ink">
                            {t('skills.from_team')}
                          </span>
                        )}
                      </div>
                      <CardDescription className="line-clamp-2 text-[11px]">
                        {pack.description || pack.category}
                      </CardDescription>
                      <span className="mt-auto flex items-center justify-between text-[10px] text-text-tertiary">
                        <span>{t('skills.count', { count: pack.count })}</span>
                        <span className={active ? 'text-accent-ink' : ''}>
                          {active ? t('skills.pack_enabled') : t('skills.pack_disabled')}
                        </span>
                      </span>
                    </Card>
                  )
                })}
              </div>

              <div className="sticky bottom-0 flex items-center gap-2 border-t border-border/70 bg-bg/95 py-3 backdrop-blur">
                <Button loading={saving} disabled={!dirty} onClick={() => void save()}>
                  <Save size={14} /> {t('skills.save')}
                </Button>
                {dirty && (
                  <span className="text-[11px] text-text-tertiary">
                    {selected.length} / {packs.length}
                  </span>
                )}
              </div>
            </>
          ) : filteredItems.length === 0 ? (
            <p className="py-12 text-center text-caption text-text-tertiary">
              {t('skills.no_results')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {filteredItems.map((item) => {
                const fromTeam = teamPacks.includes(item.pack_key)
                return (
                  <li
                    key={item.id}
                    className="flex items-start gap-3 rounded-[12px] border border-border/70 bg-surface px-3 py-2.5"
                  >
                    <Package size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-caption font-medium text-text">
                          {item.title}
                        </span>
                        {fromTeam && (
                          <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent-ink">
                            {t('skills.from_team')}
                          </span>
                        )}
                      </span>
                      <span className="line-clamp-1 text-[11px] text-text-tertiary">
                        {item.summary || item.when_to_use}
                      </span>
                    </div>
                    <Switch
                      checked
                      disabled={busyItem === item.id}
                      onCheckedChange={(checked) => void toggleItem(item, checked)}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </AppShell>
    </ProtectedRoute>
  )
}
