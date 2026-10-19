import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Bot, Check, ChevronDown, ImagePlus, X } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { pressFeedback, prefersReducedMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

const MAX_FILES = 4
/** 占位文案轮播间隔（毫秒）：比一次阅读稍长，不催人 */
const PLACEHOLDER_INTERVAL = 3600

interface LocalAttachment {
  id: string
  file: File
  url: string
}

/** 供首页其它模块（灵感画廊 / 收尾 CTA）把提示词交给输入框 */
export interface HomeComposerHandle {
  /** 填入文字并聚焦；text 为空则只聚焦 */
  fill: (text?: string) => void
}

interface HomeComposerProps {
  sending: boolean
  handleRef?: Ref<HomeComposerHandle>
  /** 提交：origin 是发送键中心，用作转场帘子的扩散原点 */
  onSubmit: (text: string, files: File[], origin: { x: number; y: number } | null) => void
}

/**
 * 首页大输入框（Lovart 式 hero composer）。
 *
 * 只负责「把一句话 + 参考图收齐」，登录拦截 / 交接 / 转场都交给上层；
 * 这样首页路由文件只剩编排逻辑，输入框的交互细节集中在这里。
 */
export function HomeComposer({ sending, onSubmit, handleRef }: HomeComposerProps) {
  const { t } = useTranslation('home')
  const [value, setValue] = useState('')
  const [files, setFiles] = useState<LocalAttachment[]>([])
  const [placeholderIndex, setPlaceholderIndex] = useState(0)

  const cardRef = useRef<HTMLDivElement>(null)
  const haloRef = useRef<HTMLSpanElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const placeholderRef = useRef<HTMLSpanElement>(null)
  /** 卸载时要释放的预览 URL：用 ref 拿最新列表，避免闭包里是首帧的空数组 */
  const filesRef = useRef<LocalAttachment[]>([])
  filesRef.current = files

  const placeholders = t('composer.placeholders', { returnObjects: true }) as string[]
  const suggestions = t('suggestions.items', { returnObjects: true }) as string[]
  const canSend = value.trim().length > 0 && !sending

  const submit = () => {
    const text = value.trim()
    if (!text || sending) return
    pressFeedback(sendRef.current)
    const rect = sendRef.current?.getBoundingClientRect()
    const origin = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    onSubmit(text, files.map((item) => item.file), origin)
  }

  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return
    const next: LocalAttachment[] = []
    for (const file of Array.from(list)) {
      if (!file.type.startsWith('image/')) continue
      if (files.length + next.length >= MAX_FILES) break
      next.push({
        id: `${file.name}-${file.size}-${Date.now()}-${next.length}`,
        file,
        url: URL.createObjectURL(file),
      })
    }
    if (next.length > 0) setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES))
  }

  const removeFile = (id: string) => {
    setFiles((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((item) => item.id !== id)
    })
  }

  useImperativeHandle(
    handleRef,
    () => ({
      fill: (text) => {
        if (text) setValue(text.slice(0, 4000))
        // preventScroll：调用方自己负责平滑滚回首屏，这里聚焦不能再硬跳一次
        textareaRef.current?.focus({ preventScroll: true })
        const card = cardRef.current
        if (!card || prefersReducedMotion()) return
        // 「接住了」的反馈：卡片轻轻弹一下，告诉用户提示词已经填进来
        gsap.fromTo(card, { scale: 0.985 }, { scale: 1, duration: 0.7, ease: 'elastic.out(1, 0.45)', delay: 0.35 })
      },
    }),
    []
  )

  // 卸载时释放本地预览 URL，避免长时间使用后内存堆积
  useEffect(() => () => filesRef.current.forEach((item) => URL.revokeObjectURL(item.url)), [])

  /**
   * 占位文案轮播：旧句上移淡出 → 换字 → 新句自下而上。
   * 只在输入框为空时跑；用户一开始打字，轮播立刻停下，不跟输入抢注意力。
   */
  useEffect(() => {
    if (value || placeholders.length < 2) return
    const el = placeholderRef.current
    const timer = window.setInterval(() => {
      if (!el || prefersReducedMotion()) {
        setPlaceholderIndex((index) => (index + 1) % placeholders.length)
        return
      }
      gsap
        .timeline()
        .to(el, { yPercent: -40, opacity: 0, duration: 0.28, ease: 'power2.in' })
        .add(() => setPlaceholderIndex((index) => (index + 1) % placeholders.length))
        .fromTo(el, { yPercent: 40, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.42, ease: 'csPaper' })
    }, PLACEHOLDER_INTERVAL)
    return () => {
      window.clearInterval(timer)
      if (el) gsap.killTweensOf(el)
    }
  }, [value, placeholders.length])

  /**
   * 聚焦：卡片轻轻"端起来"，外圈青柠光开始慢呼吸；离焦立刻收干净。
   * 呼吸用 GSAP 而不是 CSS animation：快速 Tab 切走时 CSS 动画容易残留一帧光圈。
   */
  const liftComposer = (on: boolean) => {
    const card = cardRef.current
    const halo = haloRef.current
    if (!card || !halo || prefersReducedMotion()) return
    gsap.to(card, { y: on ? -2 : 0, duration: on ? 0.35 : 0.5, ease: on ? 'power2.out' : 'power3.out' })
    gsap.killTweensOf(halo)
    if (on) {
      gsap.to(halo, { opacity: 1, duration: 0.4, ease: 'power2.out' })
      gsap.to(halo, { scale: 1.012, duration: 1.8, ease: 'sine.inOut', repeat: -1, yoyo: true, delay: 0.4 })
    } else {
      gsap.to(halo, { opacity: 0, scale: 1, duration: 0.3, ease: 'power2.out' })
    }
  }

  /** 发送键磁吸：指针在卡片里移动时朝指针方向偏几像素 */
  const magnetic = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current
    const btn = sendRef.current
    if (!card || !btn || event.pointerType !== 'mouse' || prefersReducedMotion()) return
    const rect = card.getBoundingClientRect()
    const relX = (event.clientX - (rect.left + rect.width / 2)) / rect.width
    const relY = (event.clientY - (rect.top + rect.height / 2)) / rect.height
    gsap.to(btn, { x: relX * 7, y: relY * 5, duration: 0.45, ease: 'power2.out' })
  }

  const resetMagnetic = () => {
    if (sendRef.current) {
      gsap.to(sendRef.current, { x: 0, y: 0, duration: 0.6, ease: 'elastic.out(1, 0.5)' })
    }
  }

  return (
    <div className="w-full">
      <div
        ref={cardRef}
        onPointerMove={magnetic}
        onPointerLeave={resetMagnetic}
        className={cn(
          'relative rounded-[24px] border border-border/80 bg-surface p-2 shadow-float transition-[box-shadow,border-color] duration-300 sm:rounded-[28px]',
          'focus-within:border-accent-strong/60',
          sending && 'pointer-events-none'
        )}
      >
        {/* 聚焦光晕：铺在卡片背后，只露出边框外的一圈，不压文字、不吃指针 */}
        <span
          ref={haloRef}
          aria-hidden
          className="pointer-events-none absolute -inset-px -z-10 rounded-[inherit] opacity-0"
          style={{ boxShadow: 'var(--shadow-glow)' }}
        />

        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pt-2">
            {files.map((item) => (
              <div
                key={item.id}
                className="group/thumb relative h-14 w-14 overflow-hidden rounded-[12px] border border-border bg-bg-subtle"
              >
                <img src={item.url} alt={item.file.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={t('composer.remove_attach')}
                  onClick={() => removeFile(item.id)}
                  // 触屏没有 hover：小屏常显，桌面 hover 才出现
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-scrim text-scrim-text transition-opacity sm:opacity-0 sm:group-hover/thumb:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          {/* 轮播占位：textarea 原生 placeholder 无法做动画，所以用一层叠在上面的文字代替 */}
          {!value && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-4 top-3.5 overflow-hidden text-[15px] leading-relaxed text-text-faint sm:text-[17px]"
            >
              <span ref={placeholderRef} className="line-clamp-2 block will-change-transform">
                {placeholders[placeholderIndex % Math.max(placeholders.length, 1)]}
              </span>
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value.slice(0, 4000))}
            onFocus={() => liftComposer(true)}
            onBlur={() => liftComposer(false)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files).filter((file) =>
                file.type.startsWith('image/')
              )
              if (pasted.length === 0) return
              e.preventDefault()
              addFiles(pasted)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return
              // 中文输入法选词时的回车不能当发送
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              e.preventDefault()
              submit()
            }}
            rows={3}
            aria-label={t('composer.aria')}
            className="relative max-h-52 min-h-[96px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-text focus:outline-none sm:min-h-[112px] sm:text-[17px]"
          />
        </div>

        <div className="flex items-center gap-1 px-1.5 pb-1">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label={t('composer.attach_aria')}
            title={t('composer.limit')}
            disabled={files.length >= MAX_FILES}
            className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-caption text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-40"
          >
            <ImagePlus size={15} />
            <span className="hidden sm:inline">{t('composer.attach')}</span>
          </button>

          {/* Agent 模式胶囊：对标 Lovart 的「Agent ▾」，说明这句话交给谁、会怎么处理 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-full border border-border/80 px-2.5 text-caption font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
              >
                <Bot size={14} className="text-accent-strong" />
                {t('composer.mode.label')}
                <ChevronDown size={12} className="text-text-faint" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" className="w-72">
              <DropdownMenuLabel>{t('composer.mode.title')}</DropdownMenuLabel>
              <DropdownMenuItem className="items-start gap-2.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
                  <Bot size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-caption font-medium text-text">
                    {t('composer.mode.agent')}
                  </span>
                  <span className="mt-0.5 block text-micro leading-snug text-text-tertiary">
                    {t('composer.mode.agent_desc')}
                  </span>
                </span>
                <Check size={14} className="mt-1 shrink-0 text-brand-text" />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled className="text-micro text-text-faint">
                {t('composer.mode.more')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="ml-1 hidden text-micro text-text-faint lg:inline">
            {t('composer.paste_hint')}
          </span>

          <div className="ml-auto flex items-center gap-2.5">
            <span className="hidden text-micro text-text-faint md:block">{t('composer.send_hint')}</span>
            <button
              ref={sendRef}
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={t('composer.send')}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-full transition-[background-color,box-shadow,filter] duration-200',
                canSend ? 'cs-gradient-accent shadow-glow hover:brightness-105' : 'bg-bg-subtle text-text-faint'
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

      {/* 示例提示词：点一下就填进输入框，降低"第一句说什么"的门槛 */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
        <span className="mr-1 hidden text-micro text-text-faint sm:inline">{t('suggestions.title')}</span>
        {suggestions.map((item) => (
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
