import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并 className（clsx + tailwind-merge）。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 无时区的 ISO 串（后端 `datetime.utcnow()` 的默认输出）。
 * 形如 `2026-10-17T16:11:32.367454`，末尾既没有 Z 也没有 ±HH:MM。
 */
const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/**
 * 解析服务端时间。
 *
 * 后端统一用 naive UTC 存时间，JSON 里不带时区；浏览器 `new Date()` 会按**本地时区**
 * 解析，于是 UTC+8 的机器上「刚刚创建的任务」会显示成 8 小时前，生成计时直接
 * 变成 28800s。这里对「无时区」的串补一个 Z，其余（带 Z/偏移）原样交给浏览器。
 */
export function parseServerTime(value?: string | null): Date | null {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw) return null
  const normalized = NAIVE_ISO.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

/** 格式化时间为本地字符串。 */
export function formatDateTime(value?: string | null): string {
  const date = parseServerTime(value)
  if (!date) return '—'
  return date.toLocaleString()
}

/** 相对时间（最近）。 */
export function formatRelative(value?: string | null): string {
  const date = parseServerTime(value)
  if (!date) return '—'
  const diff = Date.now() - date.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return date.toLocaleDateString()
}

/** 取邮箱首字母作为头像文字。 */
export function initialOf(email?: string | null): string {
  if (!email) return '?'
  return email.trim().charAt(0).toUpperCase()
}

/** 基于字符串生成稳定的柔和背景色。 */
/**
 * 头像取色：新色板的「墨 → 橄榄」六阶，全部为低饱和深色，
 * 保证白字始终可读，也不会在暖纸底上跳出一块冷蓝/紫。
 */
export function colorFromString(value: string): string {
  const palette = ['#1a1810', '#3a470d', '#5b4a1e', '#2c3a1a', '#4b4739', '#63501f']
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 100000
  }
  return palette[hash % palette.length]
}

/** 人类可读文件大小。 */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
