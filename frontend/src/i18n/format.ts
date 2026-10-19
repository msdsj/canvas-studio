import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { getLanguageMeta } from './languages'

/**
 * 跟随当前语言的格式化工具：数字 / 日期 / 相对时间 / 时长。
 *
 * 组件里不要再手写 `${n} 张`、`MM-DD HH:mm` 这类拼接——换语言时它们不会跟着变。
 * Intl 实例按语言缓存，避免列表渲染时每行 new 一次。
 */
export function useFormatters() {
  const { i18n } = useTranslation()
  const locale = getLanguageMeta(i18n.resolvedLanguage ?? i18n.language).intl

  return useMemo(() => {
    const number = new Intl.NumberFormat(locale)
    const dateTime = new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

    return {
      locale,
      number: (value: number) => number.format(value),
      dateTime: (value: Date) => dateTime.format(value),
      time: (value: Date) => time.format(value),
      /** 秒级时长：< 60s 显示 "3.2s"，否则 "1m 05s"（单位符号各语言通用） */
      duration: (ms: number) => {
        const seconds = ms / 1000
        if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
        const m = Math.floor(seconds / 60)
        const s = Math.round(seconds % 60)
        return `${m}m ${String(s).padStart(2, '0')}s`
      },
      relative: (value: Date) => {
        const diff = (value.getTime() - Date.now()) / 1000
        const abs = Math.abs(diff)
        if (abs < 60) return relative.format(Math.round(diff), 'second')
        if (abs < 3600) return relative.format(Math.round(diff / 60), 'minute')
        if (abs < 86400) return relative.format(Math.round(diff / 3600), 'hour')
        return relative.format(Math.round(diff / 86400), 'day')
      },
    }
  }, [locale])
}
