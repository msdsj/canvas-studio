import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Loader2, Package, Save, Search, Sparkles, Undo2 } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell, PageTabs } from '@/components/layout/PageShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/ui/empty-state'
import { useToast } from '@/hooks/use-toast'
import { SkillPackCard } from '@/components/skills/SkillPackCard'
import {
  skillsApi,
  type SkillPackItem,
  type SkillPackSummary,
} from '@/lib/api/onboarding'
import { errorMessage } from '@/lib/errors'

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
 *
 * v3 改动：
 * - 改用统一的 `PageShell`，容器从 1024 放到 1280，页头/间距与其它页面一致；
 * - tabs 从内容区搬进页头；
 * - **底部保存条改为悬浮胶囊**：改造前它 `sticky bottom-0` 压在最后一行卡片上，
 *   导致最后一张卡的开关点不到、标题被裁掉一半；
 * - 滚动容器补底部安全间距（`--shell-bottom-pad-float`），任何一行都不会被遮。
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
        <PageShell
          title={t('skills.title')}
          description={t('skills.subtitle')}
          bottomPad="float"
          tabs={
            <PageTabs
              items={[
                { key: 'packs', label: t('skills.tab_packs'), count: packs.length },
                { key: 'items', label: t('skills.tab_items'), count: items.length },
              ]}
              value={tab}
              onChange={(key) => setTab(key as Tab)}
            />
          }
          actions={
            teamPacks.length > 0 ? (
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-micro text-accent-ink">
                {t('skills.from_team')} · {teamPacks.length}
              </span>
            ) : undefined
          }
        >
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={18} className="animate-spin text-text-tertiary" />
            </div>
          ) : tab === 'packs' ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {packs.map((pack) => (
                <SkillPackCard
                  key={pack.key}
                  pack={pack}
                  active={selected.includes(pack.key)}
                  fromTeam={teamPacks.includes(pack.key)}
                  onToggle={togglePack}
                />
              ))}
            </div>
          ) : filteredItems.length === 0 ? (
            <EmptyState
              icon={Sparkles}
              title={t('skills.no_results')}
              description={t('skills.no_results_desc')}
              action={
                query
                  ? { label: t('skills.clear_filter'), onClick: () => setQuery('') }
                  : undefined
              }
              hints={[t('skills.hint_1'), t('skills.hint_2')]}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <label className="relative mb-2 flex w-full max-w-[320px] items-center">
                <Search
                  size={15}
                  className="pointer-events-none absolute left-3 text-text-tertiary"
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('skills.search_placeholder')}
                  className="h-9 pl-9 text-caption"
                />
              </label>
              {filteredItems.map((item) => {
                const fromTeam = teamPacks.includes(item.pack_key)
                return (
                  <div
                    key={item.id}
                    className="flex items-start gap-3 rounded-[12px] border border-border/70 bg-surface px-4 py-3 transition-colors hover:border-border-strong"
                  >
                    <Package size={15} className="mt-0.5 shrink-0 text-text-tertiary" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-ui font-medium text-text">{item.title}</span>
                        {fromTeam && (
                          <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-micro text-accent-ink">
                            {t('skills.from_team')}
                          </span>
                        )}
                      </span>
                      <span className="line-clamp-2 text-caption leading-relaxed text-text-tertiary">
                        {item.summary || item.when_to_use}
                      </span>
                    </div>
                    <Switch
                      checked
                      disabled={busyItem === item.id}
                      onCheckedChange={(checked) => void toggleItem(item, checked)}
                      aria-label={item.title}
                    />
                  </div>
                )
              })}
            </div>
          )}

          {/* 悬浮保存条：只有真的改了才出现，且不压住任何一行 */}
          <div
            className={
              dirty
                ? 'fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 shadow-float transition-all duration-[240ms] ease-[var(--ease-out)]'
                : 'pointer-events-none fixed bottom-5 left-1/2 z-30 flex -translate-x-1/2 translate-y-3 items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 opacity-0 shadow-float transition-all duration-[240ms] ease-[var(--ease-out)]'
            }
          >
            <span className="text-caption tabular-nums text-text-secondary">
              {selected.length} / {packs.length}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!dirty}
              onClick={() => setSelected(initial)}
            >
              <Undo2 size={14} /> {t('skills.reset')}
            </Button>
            <Button size="sm" loading={saving} disabled={!dirty} onClick={() => void save()}>
              <Save size={14} /> {t('skills.save')}
            </Button>
          </div>
        </PageShell>
      </AppShell>
    </ProtectedRoute>
  )
}
