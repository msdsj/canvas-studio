import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  ArrowRight,
  Check,
  Code2,
  Loader2,
  Megaphone,
  Package,
  PanelsTopLeft,
  PenTool,
  ShoppingBag,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/use-auth'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/hooks/use-toast'
import { onboardingApi, skillsApi, type Persona, type SkillPackSummary } from '@/lib/api/onboarding'
import { errorMessage } from '@/lib/errors'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

/** Scene icons use a consistent line-icon set instead of platform-dependent emoji. */
const PERSONA_ICONS: Record<string, LucideIcon> = {
  ecommerce: ShoppingBag,
  marketing: Megaphone,
  ui_designer: PanelsTopLeft,
  developer: Code2,
  brand: Package,
  content: PenTool,
  general: Sparkles,
}

/**
 * 首登引导。
 *
 * 首次进入只选择工作身份，企业空间由平台管理员开通。
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

  const [step, setStep] = useState(0)
  const [personas, setPersonas] = useState<Persona[]>([])
  const [packs, setPacks] = useState<SkillPackSummary[]>([])
  const [personaKey, setPersonaKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ count: number } | null>(null)

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

  const finish = useCallback(async (useDefault = false) => {
    setSubmitting(true)
    try {
      const data = await onboardingApi.complete({
        persona_key: useDefault ? '' : personaKey,
      })
      /*
       * 必须刷新登录态：`ProtectedRoute` 用 `user.persona_key` 判断「是否已完成引导」，
       * 而 store 里的 user 还是引导前的旧对象。不刷新的话，用户点完「进入工作台」
       * 会被立刻弹回引导页——看起来像按钮没反应，其实是无限重定向。
       */
      await refreshUser()
      setResult({ count: data.pack_names.length })
      setStep(1)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [personaKey, toast, refreshUser])

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
        <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-5 sm:px-10">
          <div className="flex items-center gap-2 text-text-secondary">
            <Sparkles size={16} className="text-accent-ink" />
            <span className="text-caption font-medium">{t('meta.step', { current: step + 1, total: 1 })}</span>
          </div>
          {step === 0 && (
            <button
              type="button"
              onClick={() => void finish(true)}
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
                        'group relative flex min-h-[132px] flex-col gap-2 rounded-[8px] border p-4 text-left transition-[border-color,box-shadow,transform,background-color] duration-200',
                        active
                          ? 'border-accent-strong bg-accent-soft/45 shadow-lift'
                          : 'border-border/70 bg-surface shadow-xs hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift',
                      )}
                    >
                      <span className="flex items-start justify-between">
                        <span
                          className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-[8px] transition-colors',
                            active
                              ? 'bg-accent-strong text-on-accent'
                              : 'bg-bg-subtle text-text-secondary group-hover:text-text',
                          )}
                        >
                          {(() => {
                            const Icon = PERSONA_ICONS[persona.key] ?? Sparkles
                            return <Icon size={17} strokeWidth={1.8} />
                          })()}
                        </span>
                        {active && (
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-strong text-on-accent">
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

              {previewPacks.length > 0 && (
                <div className="rounded-[8px] border border-border/70 bg-surface px-4 py-3 shadow-xs">
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

              <div className="flex justify-end pt-1">
                <Button size="lg" disabled={!personaKey || submitting} loading={submitting} onClick={() => void finish()}>
                  {t('action.finish')} <ArrowRight size={16} />
                </Button>
              </div>
            </section>
          )}

          {/* ---------- 第 3 步：完成 ---------- */}
          {step === 1 && result && (
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
