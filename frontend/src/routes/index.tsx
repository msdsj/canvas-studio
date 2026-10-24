import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { gsap, ScrollTrigger } from '@/lib/gsap'
import { useAuth } from '@/hooks/use-auth'
import { useUIStore } from '@/stores/ui'
import { useComposerHandoff } from '@/stores/composer'
import { enterStudio, prefersReducedMotion, useReveal, useSpotlight } from '@/lib/motion'
import { AgentCore } from '@/components/home/AgentCore'
import { AgentWorkflowStrip } from '@/components/home/AgentWorkflowStrip'
import { FloatingSignals } from '@/components/home/FloatingSignals'
import { HomeComposer, type HomeComposerHandle } from '@/components/home/HomeComposer'
import { HomeHeader } from '@/components/home/HomeHeader'
import { HowItWorks } from '@/components/home/HowItWorks'
import { PreviewSection } from '@/components/home/CanvasPreview'
import { StyleMarquee } from '@/components/home/StyleMarquee'
import { ShowcaseStory } from '@/components/home/ShowcaseStory'
import { InspirationGallery } from '@/components/home/InspirationGallery'
import { StatsStrip } from '@/components/home/StatsStrip'
import { FaqAccordion } from '@/components/home/FaqAccordion'
import { FinalCta } from '@/components/home/FinalCta'
import { HomeFooter } from '@/components/home/HomeFooter'

export const Route = createFileRoute('/')({
  component: HomePage,
})

/**
 * 首页：MSDSJ 设计 Agent 的门面 + 唯一入口「开始对话」。
 *
 * 路由文件只做编排（登录拦截 → 交接 → 转场）；视觉与交互细节都在 components/home/。
 *
 * 页面叙事（自上而下）：
 *   首屏输入 → 产品自演预览 → 风格跑马灯 → 三大亮点滚动叙事 → 灵感画廊
 *   → 工作方式与能力 → 产品事实 → FAQ → 收尾 CTA → 页脚
 * 每一屏都给一个「回到输入框」的理由，最终所有路径都汇到同一个输入框。
 */
function HomePage() {
  const { t } = useTranslation('home')
  const navigate = useNavigate()
  const { user } = useAuth()
  const openAuth = useUIStore((s) => s.openAuth)
  const authOpen = useUIStore((s) => s.authOpen)
  const stage = useComposerHandoff((s) => s.stage)

  const [sending, setSending] = useState(false)
  /** 未登录提交：登录成功后自动继续这次提交，用户不用再按一次 */
  const [awaitingAuth, setAwaitingAuth] = useState(false)
  /** 最近一次发送键位置：登录回来续传时，转场仍从发送键扩散 */
  const originRef = useRef<{ x: number; y: number } | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const auroraRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const composerRef = useRef<HomeComposerHandle>(null)

  // 首屏「组装式」入场：Agent 核 → 徽标 → 标题 → 说明 → 状态条 → 输入框，依次就位
  useReveal(rootRef, { selector: '[data-hero]', y: 22, stagger: 0.08, duration: 0.72, delay: 0.05 })
  // 光标光斑：让大留白有"被照亮"的感觉
  useSpotlight(auroraRef, 460)

  /**
   * 标题：主句逐行升起，强调句后到，青柠下划线从左向右"画"出来。
   * 不用 SplitText 逐字：中英文切换后字数不同，逐字时长会忽长忽短；按块做节奏更稳定。
   */
  useEffect(() => {
    const title = titleRef.current
    if (!title || prefersReducedMotion()) return
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: 0.18 })
      tl.from('[data-title-line]', {
        yPercent: 105,
        opacity: 0,
        duration: 0.9,
        stagger: 0.12,
        ease: 'csPaper',
      }).from(
        '[data-underline]',
        { scaleX: 0, transformOrigin: 'left center', duration: 0.7, ease: 'power3.inOut' },
        '-=0.35'
      )
    }, title)
    return () => ctx.revert()
  }, [t])

  /** 背景光团：呼吸 + 指针视差（外层跟指针、内层自己浮，两层分开避免互相覆盖 transform） */
  useEffect(() => {
    const root = auroraRef.current
    if (!root || prefersReducedMotion()) return
    const layers = Array.from(root.querySelectorAll<HTMLElement>('[data-depth]'))
    const ctx = gsap.context(() => {
      layers.forEach((layer, index) => {
        gsap.to(layer.firstElementChild, {
          yPercent: index % 2 === 0 ? -6 : 7,
          xPercent: index % 2 === 0 ? 3 : -3,
          scale: 1.06,
          duration: 7 + index * 1.6,
          repeat: -1,
          yoyo: true,
          ease: 'sine.inOut',
          delay: index * 0.5,
        })
      })
    }, root)
    const setters = layers.map((layer) => ({
      x: gsap.quickTo(layer, 'x', { duration: 1.1, ease: 'power3.out' }),
      y: gsap.quickTo(layer, 'y', { duration: 1.1, ease: 'power3.out' }),
      depth: Number(layer.dataset.depth) || 1,
    }))
    const onMove = (event: PointerEvent) => {
      const dx = event.clientX / window.innerWidth - 0.5
      const dy = event.clientY / window.innerHeight - 0.5
      setters.forEach((setter) => {
        setter.x(dx * 30 * setter.depth)
        setter.y(dy * 22 * setter.depth)
      })
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      ctx.revert()
    }
  }, [])

  // 字体晚到会改变各段高度：钉住与触发位置要在字体就绪后重算一次，否则滚动叙事会错位
  useEffect(() => {
    let alive = true
    void document.fonts?.ready.then(() => {
      if (alive) ScrollTrigger.refresh()
    })
    return () => {
      alive = false
    }
  }, [])

  /** 平滑滚回首屏并把提示词交给输入框（灵感画廊 / 收尾 CTA 共用） */
  const backToComposer = useCallback((prompt?: string) => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    composerRef.current?.fill(prompt)
  }, [])

  /** 转场 + 跳转：把这句话交给工作室，由对话面板自动提交。 */
  const goStudio = useCallback(
    async (text: string, attach: File[]) => {
      if (!text.trim()) return
      setSending(true)
      stage(text, attach)
      await enterStudio(originRef.current, () => {
        void navigate({ to: '/workspace' })
      })
      // 目标页已经接管，回到首页时按钮不该永远转圈
      window.setTimeout(() => setSending(false), 900)
    },
    [navigate, stage]
  )

  const handleSubmit = (text: string, files: File[], origin: { x: number; y: number } | null) => {
    if (sending) return
    originRef.current = origin
    if (!user) {
      // 未登录：先把内容存住，登录回来接着走，一个字都不用重打
      stage(text, files)
      setAwaitingAuth(true)
      openAuth('register', t('auth.continue'))
      return
    }
    void goStudio(text, files)
  }

  // 登录成功 → 自动继续刚才那次提交
  useEffect(() => {
    if (!awaitingAuth || !user) return
    setAwaitingAuth(false)
    const pending = useComposerHandoff.getState().consume()
    if (pending.text) void goStudio(pending.text, pending.files)
  }, [awaitingAuth, user, goStudio])

  // 关掉弹窗没登录 → 取消"等待登录"状态，避免以后某次登录被误触发
  useEffect(() => {
    if (!authOpen && awaitingAuth && !user) setAwaitingAuth(false)
  }, [authOpen, awaitingAuth, user])

  /** 底部 CTA：已登录直接进工作室，未登录唤起注册 */
  const startFromCta = () => {
    if (user) void navigate({ to: '/workspace' })
    else openAuth('register', t('auth.register'))
  }

  return (
    <div ref={rootRef} className="relative flex min-h-screen flex-col overflow-x-clip bg-transparent">
      {/* 环境层：纸纹 + 三团光 + 极淡网格，撑起纵深；全部 pointer-events:none */}
      <div ref={auroraRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="cs-grain absolute inset-0 opacity-70" />
        <div data-depth="1.4" className="absolute -left-24 -top-40">
          <div className="h-[440px] w-[440px] rounded-full bg-accent/30 blur-[120px]" />
        </div>
        <div data-depth="0.8" className="absolute -right-24 top-[-8%]">
          {/* 用 brand-subtle：亮色是暖砂、暗色是暖墨，两种主题下都只是"一点纵深"而不是色块 */}
          <div className="h-[380px] w-[380px] rounded-full bg-brand-subtle blur-[120px]" />
        </div>
        <div data-depth="1.9" className="absolute left-1/3 top-[70vh]">
          <div className="h-[380px] w-[520px] rounded-full bg-accent/20 blur-[130px]" />
        </div>
        <div
          className="absolute inset-x-0 top-0 h-[110vh] opacity-60"
          style={{
            backgroundImage:
              'linear-gradient(to right, var(--color-border-faint) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border-faint) 1px, transparent 1px)',
            backgroundSize: '92px 92px',
            maskImage: 'radial-gradient(ellipse 70% 58% at 50% 42%, #000 20%, transparent 78%)',
            WebkitMaskImage: 'radial-gradient(ellipse 70% 58% at 50% 42%, #000 20%, transparent 78%)',
          }}
        />
      </div>

      <HomeHeader
        user={user}
        onLogin={() => openAuth('login')}
        onRegister={() => openAuth('register', t('auth.register'))}
      />

      {/* 首屏：Agent 核 + 标题 + 状态条 + 大输入框 */}
      <main className="relative z-10 flex min-h-[calc(92svh-64px)] items-center justify-center px-4 pb-10 pt-2 sm:px-8 sm:pb-14">
        <FloatingSignals />
        <div className="relative w-full max-w-[800px]">
          <div data-hero className="flex justify-center">
            <AgentCore className="w-[104px] sm:w-[136px] lg:w-[152px]" />
          </div>

          <div data-hero className="mt-1 flex justify-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-surface/70 px-3 py-1 text-micro font-medium text-text-secondary backdrop-blur">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-strong opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-strong" />
              </span>
              {t('hero.badge')}
            </span>
          </div>

          <h1
            ref={titleRef}
            className="mt-5 text-center font-display text-[34px] leading-[1.14] tracking-[-0.03em] text-text sm:text-[52px] lg:text-[60px]"
          >
            {/* 每行包一层 overflow-hidden：文字从遮罩里升起，比淡入更干净 */}
            <span className="block overflow-hidden pb-[0.06em]">
              <span data-title-line className="block">
                {t('hero.title_lead')}
              </span>
            </span>
            <span className="block overflow-hidden pb-[0.18em]">
              <span data-title-line className="relative inline-block">
                <span className="relative z-10">{t('hero.title_accent')}</span>
                {/* 青柠手绘下划线：压在基线以下，避免吃掉汉字底部笔画 */}
                <span
                  data-underline
                  aria-hidden
                  className="absolute inset-x-[-6px] bottom-[-2px] z-0 h-[10px] rounded-full bg-accent/75 sm:h-[13px]"
                />
              </span>
            </span>
          </h1>

          <p
            data-hero
            className="mx-auto mt-4 max-w-[560px] text-center text-ui leading-relaxed text-text-secondary sm:text-body"
          >
            {t('hero.subtitle')}
          </p>

          <div data-hero className="mx-auto mt-7 max-w-[560px]">
            <AgentWorkflowStrip />
          </div>

          <div data-hero className="mt-4">
            <HomeComposer handleRef={composerRef} sending={sending} onSubmit={handleSubmit} />
          </div>
        </div>
      </main>

      <PreviewSection />
      <StyleMarquee />
      <ShowcaseStory />
      <InspirationGallery onUse={backToComposer} />
      <HowItWorks />
      <StatsStrip />
      <FaqAccordion />
      <FinalCta onStart={startFromCta} onCompose={() => backToComposer()} />
      <HomeFooter />
    </div>
  )
}
