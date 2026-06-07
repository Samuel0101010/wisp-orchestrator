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

// Keep <html lang> in sync with the active language so the page declares the
// right language for screen readers and search engines (the static index.html
// hardcodes lang="en"). SSR-safe: only touch the DOM in the browser.
function syncHtmlLang(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language;
}
syncHtmlLang();
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
