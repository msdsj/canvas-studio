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
    // en-US / en-GB 都落到 en；zh-TW 等未登记的变体回落主语言
    nonExplicitSupportedLngs: true,
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
