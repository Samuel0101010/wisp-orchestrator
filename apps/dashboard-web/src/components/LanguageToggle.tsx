import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n';

const LABELS: Record<SupportedLanguage, { native: string }> = {
  en: { native: 'English' },
  de: { native: 'Deutsch' },
};

export function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = (
    SUPPORTED_LANGUAGES.includes(i18n.resolvedLanguage as SupportedLanguage)
      ? i18n.resolvedLanguage
      : 'en'
  ) as SupportedLanguage;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const choose = (lang: SupportedLanguage): void => {
    void i18n.changeLanguage(lang);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="language-toggle"
        aria-label={t('tooltips.languageToggle')}
        className="inline-flex h-auto items-center justify-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      >
        <Languages className="h-3.5 w-3.5" />
        <span className="font-medium">{current.toUpperCase()}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-36 rounded-md border bg-popover p-1 shadow-md">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => choose(lang)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent ${
                lang === current ? 'bg-accent/50 font-medium' : ''
              }`}
              data-testid={`language-toggle-${lang}`}
            >
              <span>{LABELS[lang].native}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
