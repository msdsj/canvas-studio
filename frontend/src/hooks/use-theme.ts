import { useThemeStore } from '@/stores/theme'

/**
 * 主题读写。
 *
 * `setMode(mode, origin?)` —— 第二个参数是触发元素（通常是那颗按钮）。
 * 传了它就是扩散原点；不传则从视口中心扩散。
 */
export function useTheme() {
  const mode = useThemeStore((s) => s.mode)
  const resolved = useThemeStore((s) => s.resolved)
  const setMode = useThemeStore((s) => s.setMode)
  return { mode, resolved, setMode, isDark: resolved === 'dark' }
}
