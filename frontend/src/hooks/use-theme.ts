import { useThemeStore } from '@/stores/theme'

/** 主题读写。 */
export function useTheme() {
  const mode = useThemeStore((s) => s.mode)
  const resolved = useThemeStore((s) => s.resolved)
  const setMode = useThemeStore((s) => s.setMode)
  return { mode, resolved, setMode, isDark: resolved === 'dark' }
}
