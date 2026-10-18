import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  ArrowUp,
  ImagePlus,
  Layers,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react'
import gsap from 'gsap'
import { Avatar } from '@/components/ui/avatar'
import { useAuth } from '@/hooks/use-auth'
import { useUIStore } from '@/stores/ui'
import { useComposerHandoff } from '@/stores/composer'
import {
  enterStudio,
  pressFeedback,
  prefersReducedMotion,
  useReveal,
  useSplitReveal,
  useSpotlight,
} from '@/lib/motion'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/')({
  component: HomePage,
})

/** 首页的示例提示词：点一下就填进输入框，降低"第一句说什么"的门槛。 */
const SUGGESTIONS = [
  '极简咖啡品牌海报，暖砂纸质感，居中排版',
  '产品摄影：透明玻璃香水瓶，柔光，浅灰背景',
  '一张未来感音乐节主视觉，荧光青柠与墨黑',
  '把这张照片改成日系胶片风格',
]

const PILLARS = [
  { icon: Wand2, label: '一句话出图', desc: '模型负责构图、配色与排版' },
  { icon: Layers, label: '同一张画布', desc: '生成结果直接落进工作区' },
  { icon: Sparkles, label: '失败不扣额度', desc: '没生成出来自动退回' },
]

interface LocalAttachment {
  id: string
  file: File
  url: string
}

/** 首页：产品门面 + 唯一入口的「开始对话」。不承担任何业务，只负责把一句话交出去。 */
function HomePage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const openAuth = useUIStore((s) => s.openAuth)
  const authOpen = useUIStore((s) => s.authOpen)
  const stage = useComposerHandoff((s) => s.stage)

  const [value, setValue] = useState('')
  const [files, setFiles] = useState<LocalAttachment[]>([])
  const [sending, setSending] = useState(false)
  /** 未登录提交：登录成功后自动继续这次提交，用户不用再按一次 */
  const [awaitingAuth, setAwaitingAuth] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const auroraRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 首屏用「组装式」入场：标题逐字升起，其余元素从各自方向聚拢
  useReveal(rootRef, {
    selector: '[data-hero]',
    y: 22,
    stagger: 0.075,
    duration: 0.72,
    delay: 0.04,
  })
  useSplitReveal(titleRef, [], { stagger: 0.032, delay: 0.16, duration: 0.8 })
  // 光标光斑：只在首页出现，让大留白有"被照亮"的感觉
  useSpotlight(auroraRef, 460)

  const canSend = value.trim().length > 0 && !sending

  /** 转场 + 跳转：把这句话交给工作室，由对话面板自动提交。 */
  const goStudio = useCallback(
    async (text: string, attach: File[]) => {
      if (!text.trim()) return
      setSending(true)
      stage(text, attach)
      const rect = sendRef.current?.getBoundingClientRect()
      const origin = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
      await enterStudio(origin, () => {
        void navigate({ to: '/workspace' })
      })
      // 目标页已经接管，回到首页时按钮不该永远转圈
      window.setTimeout(() => setSending(false), 900)
    },
    [navigate, stage]
  )

  const submit = () => {
    const text = value.trim()
    if (!text || sending) return
    pressFeedback(sendRef.current)

    if (!user) {
      // 未登录：先把内容存住，登录回来接着走，一个字都不用重打
      stage(text, files.map((item) => item.file))
      setAwaitingAuth(true)
      openAuth('register', '登录后就开始生成这张画面')
      return
    }
    void goStudio(text, files.map((item) => item.file))
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

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const next: LocalAttachment[] = []
    for (const file of Array.from(list)) {
      if (!file.type.startsWith('image/')) continue
      if (files.length + next.length >= 4) break
      next.push({ id: `${file.name}-${file.size}-${next.length}`, file, url: URL.createObjectURL(file) })
    }
    if (next.length > 0) setFiles((prev) => [...prev, ...next].slice(0, 4))
  }

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((item) => item.id !== id)
    })
  }

  // 卸载时释放本地预览 URL，避免长时间使用后内存堆积
  useEffect(() => {
    return () => files.forEach((item) => URL.revokeObjectURL(item.url))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 背景视差 + 光斑呼吸。
   *
   * 外层 `[data-depth]` 只负责跟随指针平移，内层圆斑只负责上下浮动——
   * 两层分开，避免同一个元素上 CSS animation 与 GSAP inline transform 互相覆盖。
   */
  useEffect(() => {
    const root = auroraRef.current
    if (!root || prefersReducedMotion()) return
    const layers = Array.from(root.querySelectorAll<HTMLElement>('[data-depth]'))

    const ctx = gsap.context(() => {
      // 呼吸：每团光各自的周期，避免三团同步显得机械
      layers.forEach((layer, index) => {
        const blob = layer.firstElementChild
        if (!blob) return
        gsap.to(blob, {
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
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      ctx.revert()
    }
  }, [])

  /**
   * 输入区聚焦：轻轻"端起来"（scale）+ 外圈青柠光呼吸一次。
   *
   * 呼吸用一条延迟很长的 yoyo 补间而不是 CSS animation：
   * 焦点态随时可能被拿走，GSAP 能保证离焦瞬间立刻收干净，
   * CSS animation 则需要额外一层 class 切换，容易在快速 Tab 时残留。
   */
  const liftComposer = (on: boolean) => {
    const card = composerRef.current
    if (!card || prefersReducedMotion()) return
    gsap.to(card, {
      scale: on ? 1.006 : 1,
      duration: on ? 0.35 : 0.5,
      ease: on ? 'power2.out' : 'power3.out',
    })
    const halo = card.querySelector<HTMLElement>('[data-composer-halo]')
    if (!halo) return
    gsap.killTweensOf(halo)
    if (on) {
      gsap.to(halo, { opacity: 1, duration: 0.4, ease: 'power2.out' })
      gsap.to(halo, {
        scale: 1.012,
        duration: 1.8,
        ease: 'sine.inOut',
        repeat: -1,
        yoyo: true,
        delay: 0.4,
      })
    } else {
      gsap.to(halo, { opacity: 0, scale: 1, duration: 0.3, ease: 'power2.out' })
    }
  }

  /** 发送键的磁性跟随：指针在输入区内移动时，按钮朝指针方向偏几像素。 */
  const magneticSend = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = composerRef.current
    const btn = sendRef.current
    if (!card || !btn || prefersReducedMotion()) return
    const rect = card.getBoundingClientRect()
    const relX = (event.clientX - (rect.left + rect.width / 2)) / rect.width
    const relY = (event.clientY - (rect.top + rect.height / 2)) / rect.height
    gsap.to(btn, { x: relX * 7, y: relY * 5, duration: 0.45, ease: 'power2.out' })
  }

  const resetSend = () => {
    if (!sendRef.current) return
    gsap.to(sendRef.current, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.5)' })
  }

  return (
    <div ref={rootRef} className="relative flex min-h-screen flex-col overflow-x-hidden bg-transparent">
      {/* 环境层：纸纹 + 三团光 + 极淡网格，撑起纵深；全部 pointer-events:none */}
      <div ref={auroraRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="cs-grain absolute inset-0 opacity-70" />
        <div data-depth="1.4" className="absolute -left-24 -top-40">
          <div className="h-[440px] w-[440px] rounded-full bg-accent/35 blur-[120px]" />
        </div>
        <div data-depth="0.8" className="absolute -right-24 top-[-8%]">
          <div
            className="h-[380px] w-[380px] rounded-full blur-[120px]"
            style={{ background: 'rgba(226, 205, 160, 0.55)' }}
          />
        </div>
        <div data-depth="1.9" className="absolute bottom-[-18%] left-1/3">
          <div className="h-[380px] w-[520px] rounded-full bg-accent/20 blur-[130px]" />
        </div>
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'linear-gradient(to right, var(--color-border-faint) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border-faint) 1px, transparent 1px)',
            backgroundSize: '92px 92px',
            maskImage: 'radial-gradient(ellipse 70% 58% at 50% 42%, #000 20%, transparent 78%)',
            WebkitMaskImage: 'radial-gradient(ellipse 70% 58% at 50% 42%, #000 20%, transparent 78%)',
          }}
        />
      </div>

      {/* 顶栏：登录按钮固定在右上角 */}
      <header className="relative z-30">
        <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between gap-3 px-5 sm:px-8">
          <Link to="/" className="flex items-center gap-2.5 text-text">
            <span aria-hidden className="cs-logo-mark h-7 w-7" />
            <span className="text-ui font-semibold tracking-[-0.02em]">Canvas Studio</span>
            <span className="ml-1 hidden rounded-full border border-border px-2 py-[3px] text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary sm:inline">
              AI Design Agent
            </span>
          </Link>

          <div className="flex shrink-0 items-center gap-1.5">
            {user ? (
              <>
                <Link
                  to="/workspace"
                  className="group inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-caption font-semibold text-text-inverse shadow-sheet transition-[filter] hover:brightness-110"
                >
                  进入工作室
                  <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                </Link>
                <span className="ml-1 rounded-full ring-1 ring-border">
                  <Avatar name={user.display_name || user.email} size={30} />
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => openAuth('login')}
                  className="inline-flex h-9 items-center rounded-full px-3.5 text-caption font-medium text-text-secondary transition-colors hover:bg-surface/70 hover:text-text"
                >
                  登录
                </button>
                <button
                  type="button"
                  onClick={() => openAuth('register', '注册后即可开始生成第一张图')}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-brand px-4 text-caption font-semibold text-text-inverse shadow-sheet transition-[filter] hover:brightness-110"
                >
                  免费开始
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* 主视觉 */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pb-16 pt-4 sm:px-8">
        <div className="w-full max-w-[780px]">
          <div data-hero className="flex justify-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-surface/70 px-3 py-1 text-micro font-medium text-text-secondary backdrop-blur">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-strong opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-strong" />
              </span>
              设计 Agent · 对话即画布
            </span>
          </div>

          <h1
            ref={titleRef}
            className="mt-6 text-center font-display text-[40px] leading-[1.16] tracking-[-0.03em] text-text sm:text-[56px] lg:text-[62px]"
          >
            把一句话，
            <br className="sm:hidden" />
            <span className="relative inline-block">
              <span className="relative z-10">变成一张画。</span>
              {/* 青柠手绘下划线：品牌信号只出现在这里。
                  高度压在字形基线**以下**（bottom 为负），避免吃掉汉字底部笔画 */}
              <span
                aria-hidden
                className="absolute inset-x-[-6px] -bottom-[6px] z-0 h-[12px] rounded-full bg-accent/75 sm:-bottom-[8px] sm:h-[14px]"
              />
            </span>
          </h1>

          <p
            data-hero
            className="mx-auto mt-5 max-w-[520px] text-center text-ui leading-relaxed text-text-secondary sm:text-body"
          >
            描述你想要的画面，模型负责构图、配色与排版。
            <br className="hidden sm:block" />
            结果落在同一张无限画布上，接着改、接着画。
          </p>

          {/* 大型「开始对话」输入框 */}
          <div data-hero className="mt-9">
            <div
              ref={composerRef}
              onPointerMove={magneticSend}
              onPointerLeave={resetSend}
              className={cn(
                'group relative rounded-[26px] border border-border/80 bg-surface p-2 shadow-float transition-[box-shadow,border-color,transform] duration-300',
                'focus-within:border-accent-strong/60 focus-within:shadow-glow',
                sending && 'pointer-events-none'
              )}
            >
              {/* 聚焦时的青柠呼吸光晕：铺在卡片背后（-z-10），只露出边框外的一圈，
                  不压住输入文字，也不吃指针事件 */}
              <span
                data-composer-halo
                aria-hidden
                className="pointer-events-none absolute -inset-px -z-10 rounded-[27px] opacity-0"
                style={{ boxShadow: 'var(--shadow-glow)' }}
              />
              {files.length > 0 && (
                <div className="flex flex-wrap gap-2 px-2 pt-2">
                  {files.map((item) => (
                    <div
                      key={item.id}
                      className="group/thumb relative h-14 w-14 overflow-hidden rounded-[10px] border border-border bg-bg-subtle"
                    >
                      <img src={item.url} alt={item.file.name} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        aria-label="移除参考图"
                        onClick={() => removeFile(item.id)}
                        className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[rgba(12,11,7,0.7)] text-white opacity-0 transition-opacity group-hover/thumb:opacity-100"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value.slice(0, 4000))}
                onFocus={() => liftComposer(true)}
                onBlur={() => liftComposer(false)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return
                  e.preventDefault()
                  submit()
                }}
                rows={3}
                placeholder="描述你想生成的画面，例如：一张极简咖啡品牌海报，暖砂纸质感，居中排版…"
                aria-label="开始对话"
                className="max-h-52 min-h-[104px] w-full resize-none bg-transparent px-4 pt-3.5 text-[16px] leading-relaxed text-text placeholder:text-text-faint focus:outline-none sm:text-[17px]"
              />

              <div className="flex items-center gap-1 px-2 pb-1.5">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  aria-label="添加参考图"
                  data-motion="lift"
                  className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-caption text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
                >
                  <ImagePlus size={15} />
                  <span className="hidden sm:inline">参考图</span>
                </button>
                <span className="hidden text-micro text-text-faint sm:inline">可粘贴截图</span>

                <div className="ml-auto flex items-center gap-2.5">
                  <span className="hidden text-micro text-text-faint sm:block">
                    Enter 发送 · Shift + Enter 换行
                  </span>
                  <button
                    ref={sendRef}
                    type="button"
                    onClick={submit}
                    disabled={!canSend}
                    aria-label="发送"
                    // 磁吸由 magneticSend 直接补间 x/y，按压交给全局委托；
                    // 两者写同一个元素的两个不同通道（translate 与 scale），不冲突
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-full transition-[background-color,box-shadow,filter] duration-200',
                      canSend
                        ? 'cs-gradient-accent shadow-glow hover:brightness-105'
                        : 'bg-bg-subtle text-text-faint'
                    )}
                  >
                    {sending ? (
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    ) : (
                      <ArrowUp size={18} strokeWidth={2.4} />
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* 示例提示词 */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
              {SUGGESTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    setValue(item)
                    textareaRef.current?.focus()
                  }}
                  data-motion="lift"
                  className="max-w-full truncate rounded-full border border-border/80 bg-surface/60 px-3 py-1.5 text-micro text-text-secondary backdrop-blur transition-colors duration-200 hover:border-accent-strong/60 hover:bg-surface hover:text-text"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>

          {/* 三条价值点：不要堆成特性墙，一行带过 */}
          <div data-hero className="mt-10 grid gap-3 sm:grid-cols-3">
            {PILLARS.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.label}
                  data-motion="row"
                  className="flex items-start gap-2.5 rounded-[14px] border border-border/60 bg-surface/50 px-3 py-2.5 backdrop-blur transition-colors hover:bg-surface"
                >
                  <span data-motion-sheen aria-hidden />
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-accent-soft text-accent-ink">
                    <Icon size={14} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-caption font-semibold text-text">{item.label}</p>
                    <p className="mt-0.5 truncate text-micro text-text-tertiary">{item.desc}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </main>

      <footer className="relative z-10 mx-auto flex w-full max-w-[1240px] flex-wrap items-center justify-between gap-2 px-5 pb-6 text-micro text-text-faint sm:px-8">
        <span>© {new Date().getFullYear()} Canvas Studio</span>
        <span>用画布的方式和模型协作</span>
      </footer>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
