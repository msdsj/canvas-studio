import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, Check, Loader2, Sparkles, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/use-auth'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/hooks/use-toast'
import { onboardingApi, skillsApi, type Persona, type SkillPackSummary } from '@/lib/api/onboarding'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

/** 场景图标：后端给的是语义 key，前端映射到图标组件，避免后端塞 emoji。 */
const PERSONA_EMOJI: Record<string, string> = {
  ecommerce: '🛍️',
  marketing: '📣',
  ui_designer: '🎨',
  developer: '🧑‍💻',
  brand: '✦',
  content: '📝',
  general: '✳️',
}

/**
 * 首登引导。
 *
 * 三步，但不做多步表单——每一步都只是「勾一下」，没有需要校验的输入：
 *   1. 选身份（决定装哪些技能包）
 *   2. 顺带建团队（可跳过）
 *   3. 完成，进工作台
 *
 * 设计取舍：**不做强制引导弹窗**。用户随时可以跳过（跳过会装一套默认技能包），
 * 因为强制引导最容易被当成路障，而技能包本身在「我的技能」里随时可改。
 */
function OnboardingPage() {
  const { t } = useTranslation('onboarding')
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useAuth()
  const refreshUser = useAuthStore((s) => s.refresh)
  const loadTeams = useTeamStore((s) => s.load)

  const [step, setStep] = useState(0)
  const [personas, setPersonas] = useState<Persona[]>([])
  const [packs, setPacks] = useState<SkillPackSummary[]>([])
  const [personaKey, setPersonaKey] = useState('')
  const [teamName, setTeamName] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ count: number; team: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [personaData, packData] = await Promise.all([
          onboardingApi.personas(),
          skillsApi.packs(),
        ])
        if (!alive) return
        setPersonas(personaData.items)
        setPacks(packData.items)
        // 默认选中「推荐」那个：多数用户进来只想快点开始，
        // 给他一个已经选好的默认值，比让他面对 7 个空选项更快
        const recommended = personaData.items.find((item) => item.key === 'ecommerce')
        setPersonaKey(recommended?.key ?? personaData.items[0]?.key ?? '')
      } catch (err) {
        if (alive) toast.error(errorMessage(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [toast])

  const current = useMemo(
    () => personas.find((item) => item.key === personaKey) ?? null,
    [personas, personaKey],
  )

  /** 当前场景会启用的技能包（用于预览，让「选了会得到什么」透明）。 */
  const previewPacks = useMemo(() => {
    if (!current) return []
    return current.packs
      .map((key) => packs.find((pack) => pack.key === key))
      .filter((pack): pack is SkillPackSummary => Boolean(pack))
  }, [current, packs])

  const finish = useCallback(async () => {
    setSubmitting(true)
    try {
      const data = await onboardingApi.complete({
        persona_key: personaKey,
        team_name: teamName.trim(),
      })
      /*
       * 必须刷新登录态：`ProtectedRoute` 用 `user.persona_key` 判断「是否已完成引导」，
       * 而 store 里的 user 还是引导前的旧对象。不刷新的话，用户点完「进入工作台」
       * 会被立刻弹回引导页——看起来像按钮没反应，其实是无限重定向。
       */
      await refreshUser()
      // 建了团队要立刻刷新团队状态，否则 isPro / 空间切换还是旧值
      if (data.team) await loadTeams(true)
      setResult({ count: data.pack_names.length, team: data.team?.name ?? null })
      setStep(2)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [personaKey, teamName, toast, loadTeams, refreshUser])

  const enter = useCallback(() => {
    void navigate({ to: '/workspace' })
  }, [navigate])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Loader2 className="animate-spin text-text-tertiary" size={22} />
      </div>
    )
  }

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-bg">
        {/* 顶部：进度 + 跳过。跳过永远可见——不给「逃出去」的路，用户就会关标签页 */}
        <header className="flex items-center justify-between px-6 py-5 sm:px-10">
          <div className="flex items-center gap-2 text-text-secondary">
            <Sparkles size={16} className="text-accent-ink" />
            <span className="text-caption font-medium">{t('meta.step', { current: step + 1, total: 3 })}</span>
          </div>
          {step < 2 && (
            <button
              type="button"
              onClick={() => void finish()}
              className="text-caption text-text-tertiary underline-offset-4 transition-colors hover:text-text hover:underline"
            >
              {t('action.skip')}
            </button>
          )}
        </header>

        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 pb-16 sm:px-10">
          {/* ---------- 第 1 步：选身份 ---------- */}
          {step === 0 && (
            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h1 className="text-h1 font-semibold tracking-[-0.02em] text-text">
                  {t('meta.title')}
                </h1>
                <p className="max-w-[56ch] text-ui leading-relaxed text-text-secondary">
                  {t('meta.subtitle')}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {personas.map((persona) => {
                  const active = persona.key === personaKey
                  return (
                    <button
                      key={persona.key}
                      type="button"
                      data-motion="press"
                      onClick={() => setPersonaKey(persona.key)}
                      className={cn(
                        'group relative flex flex-col gap-2 rounded-[16px] border p-4 text-left transition-[border-color,box-shadow,transform] duration-200',
                        active
                          ? 'border-accent-strong bg-accent-soft/40 shadow-lift'
                          : 'border-border/70 bg-surface shadow-sheet hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift',
                      )}
                    >
                      <span className="flex items-center justify-between">
                        <span className="text-[20px] leading-none">
                          {PERSONA_EMOJI[persona.key] ?? '✳️'}
                        </span>
                        {active && (
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-strong text-text-inverse">
                            <Check size={12} strokeWidth={3} />
                          </span>
                        )}
                      </span>
                      <span className="text-md font-semibold text-text">{persona.name}</span>
                      <span className="text-caption leading-relaxed text-text-secondary">
                        {persona.tagline}
                      </span>
                      <span className="mt-auto pt-1 text-[11px] text-text-tertiary">
                        {t('persona.skills_suffix', { count: persona.skill_count })}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* 选了什么会得到什么：透明比神秘更好 */}
              {previewPacks.length > 0 && (
                <div className="rounded-[14px] border border-border/70 bg-surface px-4 py-3">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.1em] text-text-tertiary">
                    {t('preview.heading')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {previewPacks.map((pack) => (
                      <span
                        key={pack.key}
                        className="rounded-full bg-bg-subtle px-2.5 py-1 text-[11px] text-text-secondary"
                      >
                        {pack.name} · {pack.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <Button size="lg" disabled={!personaKey} onClick={() => setStep(1)}>
                  {t('action.continue')} <ArrowRight size={16} />
                </Button>
              </div>
            </section>
          )}

          {/* ---------- 第 2 步：团队空间 ---------- */}
          {step === 1 && (
            <section className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h1 className="flex items-center gap-2 text-h1 font-semibold tracking-[-0.02em] text-text">
                  <Users size={22} className="text-accent-ink" />
                  {t('team.heading')}
                </h1>
                <p className="max-w-[60ch] text-ui leading-relaxed text-text-secondary">
                  {t('team.hint')}
                </p>
              </div>

              <div className="max-w-md">
                <Input
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                  placeholder={t('team.placeholder')}
                  maxLength={60}
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(0)}>
                  <ArrowLeft size={16} /> {t('action.back')}
                </Button>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={() => void finish()} disabled={submitting}>
                    {t('team.skip')}
                  </Button>
                  <Button onClick={() => void finish()} loading={submitting}>
                    {submitting
                      ? t('team.creating')
                      : teamName.trim()
                        ? t('team.create')
                        : t('action.finish')}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {/* ---------- 第 3 步：完成 ---------- */}
          {step === 2 && result && (
            <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                <Check size={30} strokeWidth={2.6} />
              </span>
              <h1 className="text-h1 font-semibold tracking-[-0.02em] text-text">
                {t('done.title')}
              </h1>
              <p className="max-w-[46ch] text-ui leading-relaxed text-text-secondary">
                {t('done.description', { count: result.count })}
              </p>
              {result.team && (
                <p className="text-caption text-text-tertiary">
                  {t('done.team_created', { name: result.team })}
                </p>
              )}
              <Button size="lg" className="mt-2" onClick={enter}>
                {t('action.finish')} <ArrowRight size={16} />
              </Button>
            </section>
          )}
        </main>

        {/* 底部身份提示：让人确认「没走错账号」 */}
        <footer className="px-6 pb-6 text-center text-[11px] text-text-tertiary sm:px-10">
          {user?.email}
        </footer>
      </div>
    </ProtectedRoute>
  )
}
