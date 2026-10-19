import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { DEFAULT_LANGUAGE, LANGUAGES, SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages'

export { DEFAULT_LANGUAGE, LANGUAGES, SUPPORTED_LANGUAGES, type SupportedLanguage }
export { getLanguageMeta, normalizeLanguage } from './languages'

/**
 * 国际化入口。
 *
 * 文案按「语言目录 / 命名空间文件」组织：`locales/<lng>/<ns>.json`。
 * 用 `import.meta.glob` 一次性收集，所以：
 * - 新增命名空间 = 在每个语言目录里放一个同名 json，不用改这里；
 * - 新增语言 = 复制 `locales/zh-CN` 为 `locales/<lng>` 并翻译，
 *   再到 `languages.ts` 登记一行元数据（显示名 / 书写方向 / Intl 区域）。
 *
 * 缺失的 key 会回落到 zh-CN（主语言，文案最全），不会在界面上露出 key 名。
 */
const modules = import.meta.glob<Record<string, unknown>>('./locales/*/*.json', {
  eager: true,
  import: 'default',
})

type Resources = Record<string, Record<string, Record<string, unknown>>>

const resources: Resources = {}
const namespaces = new Set<string>()
for (const [path, content] of Object.entries(modules)) {
  const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/)
  if (!match) continue
  const [, lng, ns] = match
  resources[lng] ??= {}
  resources[lng][ns] = content
  namespaces.add(ns)
}

export const NAMESPACES = [...namespaces]

/**
 * 把 `t(key, { returnObjects: true })` 的返回值收敛成数组。
 *
 * i18next 在「键不存在」或「资源尚未加载」时会原样返回 key 字符串，
 * 调用方再 `.map()` 就会抛 TypeError 打穿整页（error boundary）。
 * 所有按数组消费的翻译都该走这里。
 */
export function asList<T = string>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : []
}

/** 让 `<html lang/dir>` 跟着语言走：读屏、断字、字体回退都依赖它。 */
function syncDocumentLanguage(lng: string) {
  if (typeof document === 'undefined') return
  const meta = LANGUAGES.find((item) => lng.startsWith(item.code.split('-')[0]))
  document.documentElement.lang = meta?.code ?? lng
  document.documentElement.dir = meta?.dir ?? 'ltr'
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    // 不要开 nonExplicitSupportedLngs：它会把 supportedLngs 里的 `zh-CN` 拆成基码 `zh`
    // 去做匹配，而资源是按 `zh-CN` 存的 → 查不到 → 所有 t() 原样返回 key。
    // 语言变体的回落交给 i18next 自带的 best-match 即可：
    // en-US → en、zh-TW → zh-CN(fallback)、未登记语言 → fallbackLng。
    load: 'currentOnly',
    defaultNS: 'common',
    ns: NAMESPACES,
    interpolation: { escapeValue: false },
    returnNull: false,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'cs.language',
      caches: ['localStorage'],
    },
  })

i18n.on('languageChanged', syncDocumentLanguage)
syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANGUAGE)

export default i18n
