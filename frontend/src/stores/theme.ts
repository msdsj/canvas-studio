import { create } from 'zustand'

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
  return 'system'
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
  setMode: (mode: ThemeMode) => void
  cycle: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: readStoredMode(),
  resolved: resolveTheme(readStoredMode()),
  setMode: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* ignore */
    }
    const resolved = applyTheme(mode)
    set({ mode, resolved })
  },
  cycle: () => {
    // 顶栏按钮直切亮/暗（不走"跟随系统"中间态），保证每次点击都有明确视觉反馈；
    // "跟随系统"仅在设置页的主题下拉中提供。
    const current = get().resolved
    get().setMode(current === 'dark' ? 'light' : 'dark')
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
