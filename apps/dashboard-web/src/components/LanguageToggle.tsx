import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n';
import { IconButton } from '@/components/ui/icon-button';

const LABELS: Record<SupportedLanguage, { native: string; flag: string }> = {
  en: { native: 'English', flag: '🇬🇧' },
  de: { native: 'Deutsch', flag: '🇩🇪' },
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
      <IconButton
        label={t('tooltips.languageToggle')}
        icon={
          <>
            <Languages className="h-3.5 w-3.5" />
            <span className="font-medium">{current.toUpperCase()}</span>
          </>
        }
        size="sm"
        className="h-auto gap-1.5 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onClick={() => setOpen((o) => !o)}
        data-testid="language-toggle"
      />
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
              <span aria-hidden="true">{LABELS[lang].flag}</span>
              <span>{LABELS[lang].native}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
