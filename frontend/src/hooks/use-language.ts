import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n'

const STORAGE_KEY = 'cs.language'

function normalize(lang: string | undefined): SupportedLanguage {
  if (lang && lang.startsWith('en')) return 'en'
  return 'zh-CN'
}

function readStored(): SupportedLanguage {
  try {
    return normalize(localStorage.getItem(STORAGE_KEY) ?? undefined)
  } catch {
    return 'zh-CN'
  }
}

/** 语言切换。 */
export function useLanguage() {
  const { i18n } = useTranslation()
  const [language, setLanguageState] = useState<SupportedLanguage>(() =>
    normalize(i18n.language || readStored())
  )

  useEffect(() => {
    const next = normalize(i18n.language)
    setLanguageState(next)
  }, [i18n.language])

  const setLanguage = (lang: SupportedLanguage) => {
    void i18n.changeLanguage(lang)
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      /* ignore */
    }
    setLanguageState(lang)
  }

  return { language, setLanguage, options: SUPPORTED_LANGUAGES }
}
