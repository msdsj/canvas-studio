import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowRight, Check, Loader2, Sparkles, X } from 'lucide-react'
import gsap from 'gsap'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { authApi } from '@/lib/api/auth'
import { errorMessage } from '@/lib/errors'
import { useAuthStore } from '@/stores/auth'
import { useUIStore } from '@/stores/ui'
import { useToast } from '@/hooks/use-toast'
import { prefersReducedMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** 邮箱格式校验：本地先拦一次，避免把明显非法的输入发到后端再吃 422。 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 全站唯一的登录入口（弹窗，不是页面）。
 *
 * 为什么取消独立登录页：登录不是产品的第一个画面。用户应当先看到「能做什么」，
 * 在真正要生成时才被要求登录——所以登录是**动作的延续**，用弹窗承接，
 * 关掉弹窗就回到原来那一屏，输入的内容一个字都不丢。
 */
export function AuthDialog() {
  const { t } = useTranslation('auth')
  const { t: te } = useTranslation()
  const toast = useToast()

  const open = useUIStore((s) => s.authOpen)
  const mode = useUIStore((s) => s.authMode)
  const reason = useUIStore((s) => s.authReason)
  const closeAuth = useUIStore((s) => s.closeAuth)
  const openAuth = useUIStore((s) => s.openAuth)
  const setSession = useAuthStore((s) => s.setSession)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)

  const isRegister = mode === 'register'

  // 每次打开都清掉上一次的报错与密码：不要把上一个用户的中间状态带进来
  useEffect(() => {
    if (!open) return
    setError('')
    setPassword('')
    setConfirm('')
  }, [open, mode])

  // 入场：整块面板上浮 + 表单元素错峰，比单纯淡入更有"被推开"的空间感
  useEffect(() => {
    if (!open || prefersReducedMotion()) return
    const panel = panelRef.current
    if (!panel) return
    const ctx = gsap.context(() => {
      gsap.from(panel, { y: 26, scale: 0.97, opacity: 0, duration: 0.5, ease: 'power3.out' })
      const fields = formRef.current?.querySelectorAll('[data-auth-field]')
      if (fields && fields.length > 0) {
        gsap.from(fields, {
          y: 12,
          opacity: 0,
          duration: 0.45,
          stagger: 0.045,
          delay: 0.08,
          ease: 'power3.out',
          clearProps: 'transform,opacity',
        })
      }
    })
    return () => ctx.revert()
  }, [open, mode])

  const submit = async () => {
    setError('')
    const mail = email.trim()
    if (!mail) return setError(t('validation.email_required'))
    if (!EMAIL_RE.test(mail)) return setError(t('validation.email_invalid'))
    if (!password) return setError(t('validation.password_required'))
    if (isRegister) {
      if (password.length < 8) return setError(t('validation.password_weak'))
      if (password !== confirm) return setError(t('validation.password_mismatch'))
    }
    setLoading(true)
    try {
      if (!isRegister) {
        const result = await authApi.login(mail, password)
        setSession(result.access_token, result.user)
        toast.success('欢迎回来', result.user.display_name || result.user.email)
      } else {
        // 注册即登录：后端直接激活账号并签发 JWT，无需再走邮箱确认
        const result = await authApi.register({ email: mail, password })
        setSession(result.access_token, result.user)
        toast.success('账号已创建', '已为你登录，可以直接开始创作')
      }
      closeAuth()
    } catch (err) {
      setError(errorMessage(err, te))
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : closeAuth())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[1100] bg-[var(--overlay)] backdrop-blur-[3px] data-[state=open]:animate-[cs-rise_0.24s_ease-out]" />
        <DialogPrimitive.Content
          ref={panelRef}
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[1100] w-[calc(100vw-1.5rem)] max-w-[880px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[26px] border border-border/60 bg-surface shadow-drag focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">
            {isRegister ? t('login.tab_register') : t('login.tab_login')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Close className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text">
            <X size={17} />
            <span className="sr-only">close</span>
          </DialogPrimitive.Close>

          <div className="grid md:grid-cols-[0.86fr_1fr]">
            {/* 左：品牌面。暗底 + 青柠，是整套视觉的"签名" */}
            <aside className="relative hidden flex-col justify-between overflow-hidden bg-[#12110b] p-9 text-[#f4f1e7] md:flex">
              <div
                aria-hidden
                className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-[#cdf564]/25 blur-[80px]"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute -bottom-28 right-[-60px] h-72 w-72 rounded-full bg-[#cdf564]/12 blur-[90px]"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 opacity-[0.06]"
                style={{ backgroundImage: 'var(--texture-paper)' }}
              />

              <div className="relative flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#cdf564] text-[#12110b]">
                  <Sparkles size={16} />
                </span>
                <span className="text-ui font-semibold tracking-[-0.01em]">zleap Canvas</span>
              </div>

              <div className="relative">
                <p className="font-display text-[34px] leading-[1.14] tracking-[-0.02em]">
                  灵感来得快，
                  <br />
                  别让它等登录。
                </p>
                <ul className="mt-7 flex flex-col gap-2.5 text-caption text-[#f4f1e7]/70">
                  {['一句话生成整张画面', '结果落在同一张无限画布', '生成失败自动退回额度'].map(
                    (item) => (
                      <li key={item} className="flex items-center gap-2">
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#cdf564]/18 text-[#cdf564]">
                          <Check size={10} />
                        </span>
                        {item}
                      </li>
                    )
                  )}
                </ul>
              </div>

              <p className="relative text-micro text-[#f4f1e7]/40">
                登录只用于保存作品与计量额度
              </p>
            </aside>

            {/* 右：表单 */}
            <div ref={formRef} className="relative px-6 py-8 sm:px-9 sm:py-10">
              <>
                  <div className="mb-6">
                    <h2 className="font-display text-[30px] leading-tight tracking-[-0.02em] text-text">
                      {isRegister ? '创建账号' : '欢迎回来'}
                    </h2>
                    <p className="mt-1.5 text-caption text-text-secondary">
                      {reason || (isRegister ? '注册后即可开始生成第一张图' : '登录后继续你的创作')}
                    </p>
                  </div>

                  {/* 模式切换：两段式滑块，选中态用墨色块，避免"链接式"切换的含糊 */}
                  <div className="mb-6 grid grid-cols-2 gap-1 rounded-full bg-bg-subtle p-1">
                    {(['login', 'register'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setError('')
                          openAuth(m, reason)
                        }}
                        className={cn(
                          'h-8 rounded-full text-caption font-medium transition-all duration-200',
                          mode === m
                            ? 'bg-surface text-text shadow-xs'
                            : 'text-text-tertiary hover:text-text-secondary'
                        )}
                      >
                        {m === 'login' ? t('login.tab_login') : t('login.tab_register')}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-col gap-3.5">
                    <div data-auth-field>
                      <FormField label={t('login.email')} required htmlFor="auth-email">
                        <Input
                          id="auth-email"
                          type="email"
                          value={email}
                          autoComplete="email"
                          placeholder="you@studio.com"
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      </FormField>
                    </div>

                    <div data-auth-field>
                      <FormField label={t('login.password')} required htmlFor="auth-password">
                        <Input
                          id="auth-password"
                          type="password"
                          value={password}
                          autoComplete={isRegister ? 'new-password' : 'current-password'}
                          placeholder={isRegister ? '至少 8 位' : '••••••••'}
                          onChange={(e) => setPassword(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submit()
                          }}
                        />
                      </FormField>
                    </div>

                    {isRegister && (
                      <div data-auth-field>
                        <FormField label={t('login.confirm_password')} required htmlFor="auth-confirm">
                          <Input
                            id="auth-confirm"
                            type="password"
                            value={confirm}
                            autoComplete="new-password"
                            placeholder="再输入一次密码"
                            onChange={(e) => setConfirm(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void submit()
                            }}
                          />
                        </FormField>
                      </div>
                    )}

                    {error && (
                      <p
                        data-auth-field
                        className="rounded-[10px] bg-danger-subtle px-3 py-2 text-caption leading-snug text-danger"
                      >
                        {error}
                      </p>
                    )}

                    <button
                      data-auth-field
                      type="button"
                      disabled={loading}
                      onClick={() => void submit()}
                      className="mt-1 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand text-ui font-semibold text-text-inverse shadow-sheet transition-[filter,transform] hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
                    >
                      {loading && <Loader2 size={15} className="animate-spin" />}
                      {isRegister ? t('login.submit_register') : t('login.submit_login')}
                      {!loading && <ArrowRight size={15} />}
                    </button>

                    <div className="flex items-center justify-between pt-1 text-caption">
                      {!isRegister ? (
                        <a
                          href="/reset-password"
                          className="text-text-tertiary underline-offset-4 transition-colors hover:text-text hover:underline"
                        >
                          {t('login.forgot')}
                        </a>
                      ) : (
                        <span className="text-text-tertiary">注册即表示同意服务条款</span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setError('')
                          openAuth(isRegister ? 'login' : 'register', reason)
                        }}
                        className="font-medium text-text-secondary transition-colors hover:text-text"
                      >
                        {isRegister ? t('login.login_now') : t('login.register_now')}
                      </button>
                    </div>
                  </div>
              </>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
