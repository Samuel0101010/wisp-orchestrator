import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHealth } from '@/api/queries';

/**
 * App-wide warning strip shown when the boot auth probe failed. The dashboard
 * boots and is browsable without an authenticated `claude` CLI, but spawning
 * agent runs will fail — the server surfaces the hint on /api/health and this
 * makes it visible at the point a fresh user would otherwise be silently
 * surprised. Warning hue is carried only by the icon/border/tint; the text
 * uses the high-contrast foreground tokens so it clears WCAG AA on the base.
 */
export function AuthBanner() {
  const { t } = useTranslation();
  const { data } = useHealth();
  const [dismissed, setDismissed] = useState(false);

  const probe = data?.authProbe;
  // Hide while the probe is still pending (null) or auth is fine ({ ok: true }).
  if (dismissed || !probe || probe.ok) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-warning/40 bg-warning/10 px-6 py-2.5 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-medium text-foreground">{t('auth.bannerTitle')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {probe.hint ?? t('auth.bannerFallback')}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('buttons.close')}
        className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-warning/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
