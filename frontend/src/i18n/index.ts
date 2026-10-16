import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import zhCommon from './locales/zh-CN/common.json'
import zhAuth from './locales/zh-CN/auth.json'
import zhErrors from './locales/zh-CN/errors.json'
import zhWorkspace from './locales/zh-CN/workspace.json'
import zhCanvas from './locales/zh-CN/canvas.json'
import zhChat from './locales/zh-CN/chat.json'
import zhAssets from './locales/zh-CN/assets.json'
import zhProjects from './locales/zh-CN/projects.json'
import zhUsage from './locales/zh-CN/usage.json'
import zhSettings from './locales/zh-CN/settings.json'
import zhAdmin from './locales/zh-CN/admin.json'

import enCommon from './locales/en/common.json'
import enAuth from './locales/en/auth.json'
import enErrors from './locales/en/errors.json'
import enWorkspace from './locales/en/workspace.json'
import enCanvas from './locales/en/canvas.json'
import enChat from './locales/en/chat.json'
import enAssets from './locales/en/assets.json'
import enProjects from './locales/en/projects.json'
import enUsage from './locales/en/usage.json'
import enSettings from './locales/en/settings.json'
import enAdmin from './locales/en/admin.json'

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

const resources = {
  'zh-CN': {
    common: zhCommon,
    auth: zhAuth,
    errors: zhErrors,
    workspace: zhWorkspace,
    canvas: zhCanvas,
    chat: zhChat,
    assets: zhAssets,
    projects: zhProjects,
    usage: zhUsage,
    settings: zhSettings,
    admin: zhAdmin,
  },
  en: {
    common: enCommon,
    auth: enAuth,
    errors: enErrors,
    workspace: enWorkspace,
    canvas: enCanvas,
    chat: enChat,
    assets: enAssets,
    projects: enProjects,
    usage: enUsage,
    settings: enSettings,
    admin: enAdmin,
  },
} as const

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh-CN',
    supportedLngs: [...SUPPORTED_LANGUAGES],
    defaultNS: 'common',
    ns: [
      'common',
      'auth',
      'errors',
      'workspace',
      'canvas',
      'chat',
      'assets',
      'projects',
      'usage',
      'settings',
      'admin',
    ],
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'cs.language',
      caches: ['localStorage'],
    },
  })

export default i18n
