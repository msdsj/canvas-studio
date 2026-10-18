import { create } from 'zustand'
import { switchThemeWithRipple } from '@/lib/theme-transition'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'cs.theme'

function readStoredMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* ignore */
  }
  // 默认亮色：整套视觉以「暖砂纸 + 墨黑」为底，亮色才是主形态；
  // 暗色是同一套色板在暗房里的版本，用户可在头像菜单切换。
  return 'light'
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return 'light'
}

function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
  }
  return resolved
}

interface ThemeState {
  mode: ThemeMode
  resolved: ResolvedTheme
  /**
   * 切换主题。`origin` 是触发元素——新主题会以它为圆心扩散。
   * 不传则从视口中心扩散（例如不在页面里的逻辑调用）。
   */
  setMode: (mode: ThemeMode, origin?: HTMLElement | null) => void
  cycle: (origin?: HTMLElement | null) => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStoredMode(),
  resolved: resolveTheme(readStoredMode()),
  setMode: (mode, origin) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
    const next = resolveTheme(mode)
    // 同色（light → system 但系统也是亮色）不值得放扩散：那会让用户以为切错了
    if (next === get().resolved) {
      set({ mode })
      return
    }
    // 墨滴扩散：新主题从触发按钮位置向四周洇开，替代原先的 320ms 整页颜色渐变。
    // 扩散期间 document 上的 data-theme 还没翻，必须显式告诉它目标主题去读纸色。
    //
    // 先乐观更新 store：扩散是视觉层，状态必须先到位——否则按钮上的图标要等
    // 扩散结束才换，用户会觉得"点了没反应"；同理 `mode==='system'` 时若系统正好
    // 与目标同色，switchThemeWithRipple 内部会走 apply() 直落，状态也不会漏。
    set({ mode, resolved: next })
    void switchThemeWithRipple(origin ?? null, () => applyTheme(mode), { theme: next })
  },
  cycle: (origin) => {
    // 顶栏按钮直切亮/暗（不走"跟随系统"中间态），保证每次点击都有明确视觉反馈；
    // "跟随系统"仅在设置页的主题下拉中提供。
    const current = get().resolved
    get().setMode(current === 'dark' ? 'light' : 'dark', origin)
  },
}))

// 系统主题变化时同步
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { mode, resolved } = useThemeStore.getState()
    if (mode === 'system') {
      const next = applyTheme('system')
      if (next !== resolved) useThemeStore.setState({ resolved: next })
    }
  })
  applyTheme(useThemeStore.getState().mode)
}
