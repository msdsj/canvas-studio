/**
 * 语言登记表：界面能切换哪些语言、怎么显示、怎么格式化，全在这一处。
 *
 * 新增语言的步骤：
 *   1. 复制 `locales/zh-CN/` → `locales/<code>/`，逐个 json 翻译（key 保持不变）；
 *   2. 在下面 LANGUAGES 里加一行；
 *   3. 完事。命名空间由 i18n/index.ts 自动收集，切换菜单读这张表自动出现。
 *
 * `dir` 为 RTL 语言（ar / he）预留：切换时会写到 `<html dir>`，
 * 布局请优先使用 Tailwind 的逻辑方向类（ms-/me-/ps-/pe-/start-/end-）。
 */
export interface LanguageMeta {
  /** BCP-47 代码，同时是 locales 目录名 */
  code: string
  /** 本语言自称（菜单里永远用母语显示，用户才找得到） */
  nativeName: string
  /** 书写方向 */
  dir: 'ltr' | 'rtl'
  /** Intl 格式化用的区域（日期 / 数字 / 相对时间） */
  intl: string
}

export const LANGUAGES = [
  { code: 'zh-CN', nativeName: '简体中文', dir: 'ltr', intl: 'zh-CN' },
  { code: 'en', nativeName: 'English', dir: 'ltr', intl: 'en-US' },
] as const satisfies readonly LanguageMeta[]

export type SupportedLanguage = (typeof LANGUAGES)[number]['code']

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = LANGUAGES.map((item) => item.code)

export const DEFAULT_LANGUAGE: SupportedLanguage = 'zh-CN'

/** 把任意语言标签（en-US / zh / zh-Hans-CN）归一到已登记的语言。 */
export function normalizeLanguage(lang: string | null | undefined): SupportedLanguage {
  if (!lang) return DEFAULT_LANGUAGE
  const exact = LANGUAGES.find((item) => item.code === lang)
  if (exact) return exact.code
  const base = lang.split('-')[0].toLowerCase()
  const loose = LANGUAGES.find((item) => item.code.split('-')[0].toLowerCase() === base)
  return loose?.code ?? DEFAULT_LANGUAGE
}

export function getLanguageMeta(lang: string | null | undefined): LanguageMeta {
  const code = normalizeLanguage(lang)
  return LANGUAGES.find((item) => item.code === code) ?? LANGUAGES[0]
}
