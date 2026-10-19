import { useTranslation } from 'react-i18next'
import { LANGUAGES, normalizeLanguage, type SupportedLanguage } from '@/i18n'

/**
 * 语言切换。
 *
 * 当前语言直接从 i18n 实例派生，不再另存一份 state——两份状态在
 * 「别处调用 changeLanguage」时会不同步。持久化由 LanguageDetector 的
 * caches 负责（localStorage `cs.language`）。
 */
export function useLanguage() {
  const { i18n } = useTranslation()
  const language = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language)

  const setLanguage = (lang: SupportedLanguage) => {
    void i18n.changeLanguage(lang)
  }

  return { language, setLanguage, options: LANGUAGES }
}
