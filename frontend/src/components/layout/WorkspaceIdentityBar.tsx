import { useRef } from 'react'
import { Sparkles } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { useQuota } from '@/hooks/use-quota'
import { useUIStore } from '@/stores/ui'
import { Avatar } from '@/components/ui/avatar'
import { NotificationBell } from './NotificationBell'
import { ThemeToggle } from './ThemeToggle'
import { LocaleToggle } from './LocaleToggle'
import { UserMenu } from './UserMenu'
import { useReveal } from '@/lib/motion'

/**
 * 页面左下角的身份区。
 *
 * 结构（自上而下）：
 *   ┌──────────────────────────────────────┐
 *   │ (A)  管理员  PRO             🔔 🌙 🌐 │
 *   │      额度 11684                       │
 *   │      [ ✨ 升级 Pro ]  ← 仅普通用户    │
 *   └──────────────────────────────────────┘
 *
 * 四条硬约束：
 * 1. **全站只有一颗头像**。头像本身就是账号菜单的触发器，右边不再重复放一颗，
 *    否则会出现「左边管、右边 A」两个"我"。
 * 2. 右侧只留三个入口：通知 / 主题 / 语言，**一行排开**。额度不是操作，是信息，
 *    放在左侧昵称下面，不再占一个图标位。
 * 3. **身份等级必须一眼可见**：Pro / 管理员显示青柠 `PRO` 徽标；普通用户显示
 *    `free`，并在下方给一个自带光带的「升级 Pro」入口（这是他们的升级路径）。
 * 4. 进入页面时各元素依次落位（GSAP），让这块常驻区域也有呼吸感。
 */
export function WorkspaceIdentityBar() {
  const { user, isPro } = useAuth()
  const { balance } = useQuota()
  const openProDialog = useUIStore((s) => s.openProDialog)

  const name = user?.display_name || user?.email?.split('@')[0] || '我的工作室'
  const barRef = useRef<HTMLDivElement>(null)

  useReveal(barRef, {
    selector: '[data-id-item]',
    y: 8,
    stagger: 0.055,
    duration: 0.5,
    delay: 0.08,
  })

  const avatarTrigger = (
    <button
      type="button"
      aria-label="账号菜单"
      title={name}
      className="relative shrink-0 rounded-full ring-1 ring-border/70 transition-transform duration-200 hover:scale-[1.06] active:scale-95"
    >
      <Avatar name={user?.email} size={30} />
      {/* 在线小圆点：青柠是信号色，只在"我在这儿"这类状态上出现 */}
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent-strong" />
    </button>
  )

  return (
    <div
      ref={barRef}
      data-identity
      className="group/identity flex shrink-0 items-center gap-2 rounded-[14px] bg-surface px-2.5 py-2 shadow-sheet transition-shadow duration-300 hover:shadow-lift"
    >
      <div data-id-item className="flex shrink-0">
        <UserMenu trigger={avatarTrigger} />
      </div>

      <div data-id-item className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-micro font-medium leading-tight text-text">{name}</span>
          <span
            className={
              isPro
                ? 'shrink-0 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold uppercase leading-[14px] tracking-[0.1em] text-accent-ink ring-1 ring-inset ring-accent-strong'
                : 'shrink-0 rounded-full bg-bg-subtle px-1.5 py-px text-[10px] font-semibold uppercase leading-[14px] tracking-[0.1em] text-text-tertiary'
            }
          >
            {isPro ? 'Pro' : 'free'}
          </span>
        </span>
        <span className="truncate text-[10px] leading-tight text-text-tertiary tabular-nums">
          额度 {balance}
        </span>

        {/* 普通用户的升级入口：青柠渐变 + 扫光，是这块区域唯一"会动"的元素 */}
        {!isPro && (
          <button
            type="button"
            data-motion="press"
            onClick={() =>
              openProDialog('升级 Pro 后即可使用画布、抠图、AI 对话、提示词润色与图生图。')
            }
            className="cs-gradient-accent relative mt-1 inline-flex items-center justify-center gap-1 overflow-hidden rounded-xs px-2 py-1 text-[10px] font-semibold leading-none shadow-glow transition-[filter] duration-200 hover:brightness-105"
          >
            <span className="relative z-10 inline-flex items-center gap-1">
              <Sparkles size={11} /> 升级 Pro
            </span>
            <span
              aria-hidden
              className="cs-shimmer pointer-events-none absolute inset-0 opacity-70"
            />
          </button>
        )}
      </div>

      {/* 通知 / 主题 / 语言：一行三个图标 */}
      <div className="flex shrink-0 items-center gap-0.5">
        <span data-id-item className="flex">
          <NotificationBell iconOnly />
        </span>
        <span data-id-item className="flex">
          <ThemeToggle compact />
        </span>
        <span data-id-item className="flex">
          <LocaleToggle compact />
        </span>
      </div>
    </div>
  )
}
