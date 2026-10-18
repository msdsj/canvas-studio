import { useCallback, useRef, useState } from 'react'
import { Download, ImageOff, Loader2, Sparkles, Wand2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { useQuota } from '@/hooks/use-quota'
import { useUIStore } from '@/stores/ui'
import { generateApi } from '@/lib/api/generate'
import { apiUrl } from '@/lib/api/client'
import { errorMessage, errorTextByCode } from '@/lib/errors'
import { AppSidebar } from '@/components/layout/WorkspaceLeftbar'
import { WorkspaceIdentityBar } from '@/components/layout/WorkspaceIdentityBar'
import type { GenerationTask } from '@/types/models'

/** 常用尺寸（值与后端 size 参数一致，不引入新的取值空间）。 */
const SIZES = [
  { value: '1024x1024', label: '方形 1:1' },
  { value: '1024x1536', label: '竖版 2:3' },
  { value: '1536x1024', label: '横版 3:2' },
]

interface Props {
  /** 一次性带入的初始提示词（从旧会话 / 分享页续接时用）。 */
  initialPrompt?: string
}

/**
 * 普通用户的创作台。
 *
 * 权限分级下的「最小可用产品」——只保留一件事：**输入提示词 → 得到图片**。
 * 不做画布、不做对话、不做润色：原文原样提交，不给用户"被 AI 偷偷改写"的困惑。
 * Pro 能力以一张升级卡呈现，而不是把禁用按钮摆满一屏。
 */
export function FreeStudioView({ initialPrompt = '' }: Props) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [size, setSize] = useState(SIZES[0].value)
  const [busy, setBusy] = useState(false)
  const [tasks, setTasks] = useState<GenerationTask[]>([])
  const toast = useToast()
  const { balance } = useQuota()
  const openProDialog = useUIStore((s) => s.openProDialog)
  const pollRef = useRef<number | null>(null)

  const settle = useCallback(async (task: GenerationTask) => {
    const update = (next: GenerationTask) =>
      setTasks((list) => list.map((item) => (item.id === next.id ? next : item)))
    update(task)
    // 生成是异步任务：轮询到终态为止；超过 2 分钟就停下（避免无限转圈）
    for (let i = 0; i < 80; i += 1) {
      await new Promise((resolve) => {
        pollRef.current = window.setTimeout(resolve, 1500)
      })
      let latest: GenerationTask
      try {
        latest = await generateApi.getTask(task.id)
      } catch {
        return
      }
      update(latest)
      if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'cancelled') {
        if (latest.status === 'succeeded') toast.success('图片生成好了')
        return
      }
    }
  }, [toast])

  const submit = async () => {
    const text = prompt.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      // 原始提示词原样提交：普通用户不经过任何改写
      const task = await generateApi.image({ prompt: text, size })
      setTasks((list) => [task, ...list])
      setPrompt('')
      void settle(task)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左：导航 + 身份区。与 Pro 工作台同一套版式——普通用户同样需要
          能走到素材 / 任务 / 用量，也要看得见自己的 free 等级与升级入口。 */}
      <div className="hidden w-[232px] shrink-0 flex-col md:flex">
        <AppSidebar />
        <div className="mx-2 mb-2 mt-auto">
          <WorkspaceIdentityBar />
        </div>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto cs-thin-scroll">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-8">
          {/* 窄屏：左栏收起，身份区挪到内容顶部，否则等级与升级入口整块消失 */}
          <div className="md:hidden">
            <WorkspaceIdentityBar />
          </div>

          <header className="flex flex-col gap-1.5">
            <h1 className="font-display text-h2 tracking-[-0.016em] text-text">文字生成图片</h1>
            <p className="text-caption text-text-tertiary">
              写下你想要的画面，直接生成。额度 {balance}，每次按实际用量结算。
            </p>
          </header>

          <section className="cs-animate-rise rounded-md bg-surface p-4 shadow-sheet ring-1 ring-inset ring-border-faint">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
              }}
              rows={4}
              placeholder="例：清晨的海边灯塔，暖色逆光，胶片颗粒，海面有薄雾"
              className="rounded-xs"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {SIZES.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    data-motion="press"
                    onClick={() => setSize(item.value)}
                    className={
                      size === item.value
                        ? 'rounded-full bg-accent-soft px-2.5 py-1 text-micro font-medium text-accent-ink ring-1 ring-inset ring-accent-strong'
                        : 'rounded-full bg-bg-subtle px-2.5 py-1 text-micro text-text-tertiary transition-colors hover:text-text'
                    }
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden text-micro text-text-tertiary sm:inline">⌘/Ctrl + Enter</span>
                <Button onClick={() => void submit()} loading={busy} disabled={!prompt.trim()}>
                  <Wand2 size={15} /> 生成图片
                </Button>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-md bg-surface px-6 py-12 text-center shadow-sheet ring-1 ring-inset ring-border-faint">
                <ImageOff size={22} className="text-text-faint" />
                <p className="text-caption text-text-tertiary">还没有作品，写下第一句提示词试试</p>
              </div>
            ) : (
              tasks.map((task) => (
                <article
                  key={task.id}
                  className="cs-animate-rise rounded-md bg-surface p-3 shadow-sheet ring-1 ring-inset ring-border-faint"
                >
                  <p className="text-caption leading-snug text-text-secondary [overflow-wrap:anywhere]">
                    {task.prompt}
                  </p>
                  <div className="mt-2.5">
                    {task.status === 'succeeded' && task.result_urls.length > 0 ? (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {task.result_urls.map((url) => (
                          <a
                            key={url}
                            href={apiUrl(url)}
                            target="_blank"
                            rel="noreferrer"
                            className="group relative block overflow-hidden rounded-xs bg-bg-subtle shadow-sheet"
                          >
                            <img
                              src={apiUrl(url)}
                              alt={task.prompt}
                              loading="lazy"
                              className="aspect-square w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                            />
                            <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-full bg-scrim px-1.5 py-0.5 text-[10px] text-scrim-text opacity-0 transition-opacity group-hover:opacity-100">
                              <Download size={10} /> 原图
                            </span>
                          </a>
                        ))}
                      </div>
                    ) : task.status === 'failed' ? (
                      <p className="flex items-center gap-1.5 text-micro text-danger">
                        <ImageOff size={12} />
                        {errorTextByCode(task.error_code)}
                      </p>
                    ) : (
                      <div className="flex items-center gap-2 text-micro text-text-tertiary">
                        <Loader2 size={13} className="animate-spin text-accent-ink" />
                        {task.status === 'queued'
                          ? '排队中…'
                          : `生成中 ${Math.max(0, Math.min(99, task.progress))}%`}
                      </div>
                    )}
                  </div>
                </article>
              ))
            )}
          </section>

          {/* 升级引导：不摆一堆禁用按钮，只讲清楚"解锁后能做什么" */}
          <section className="cs-gradient-brand-soft flex flex-wrap items-center justify-between gap-3 rounded-md p-4 ring-1 ring-inset ring-border-faint">
            <div className="flex min-w-0 items-start gap-2">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-accent-ink" />
              <div className="min-w-0">
                <p className="text-caption font-medium text-text">升级 Pro，解锁完整创作台</p>
                <p className="text-micro leading-snug text-text-tertiary">
                  无限画布、AI 对话创作、图片编辑与抠图、提示词润色、图生图
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              onClick={() => openProDialog('升级 Pro 后即可使用画布、抠图、AI 对话、提示词润色与图生图。')}
            >
              了解 Pro
            </Button>
          </section>
        </div>
      </div>
    </div>
  )
}
