import type { Page } from '@playwright/test';

/**
 * Pre-set the i18n locale in localStorage so the app boots straight into the
 * requested language. Must be called before the first `page.goto()` so the
 * key is in place when i18next-browser-languagedetector reads it.
 */
export async function setLang(page: Page, lang: 'en' | 'de'): Promise<void> {
  await page.addInitScript((l: string) => {
    try {
      window.localStorage.setItem('agent-harness-lang', l);
    } catch {
      /* localStorage may be unavailable; ignore */
    }
  }, lang);
}
