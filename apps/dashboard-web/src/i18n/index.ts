import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';
import de from './locales/de/common.json';

export const SUPPORTED_LANGUAGES = ['en', 'de'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// One-time migration: rename legacy localStorage key to wisp-lang.
// Mirrors the wisp-ui migration in store/ui.ts.
if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
  const legacy = window.localStorage.getItem('agent-harness-lang');
  const current = window.localStorage.getItem('wisp-lang');
  if (legacy && !current) {
    window.localStorage.setItem('wisp-lang', legacy);
    window.localStorage.removeItem('agent-harness-lang');
  }
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'wisp-lang',
    },
    resources: {
      en: { common: en },
      de: { common: de },
    },
    defaultNS: 'common',
  });

export default i18n;
