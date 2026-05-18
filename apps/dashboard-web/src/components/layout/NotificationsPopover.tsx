import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, type GlobalRunRow } from '@/api/queries';
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import type { RunOutcome, RunStatus } from '@wisp/schemas';

const ROW_LIMIT = 8;

interface RunPresentation {
  tone: StatusPillTone;
  labelKey: string;
  live: boolean;
}

function presentRun(status: RunStatus, outcome: RunOutcome | null): RunPresentation {
  if (status === 'running') return { tone: 'info', labelKey: 'running', live: true };
  if (status === 'paused') return { tone: 'warning', labelKey: 'paused', live: false };
  if (status === 'pending') return { tone: 'neutral', labelKey: 'pending', live: false };
  if (status === 'cancelled') return { tone: 'neutral', labelKey: 'cancelled', live: false };
  if (status === 'failed') return { tone: 'destructive', labelKey: 'failed', live: false };
  // completed — fall back to outcome for tone.
  if (outcome === 'success') return { tone: 'success', labelKey: 'success', live: false };
  if (outcome === 'failure') return { tone: 'destructive', labelKey: 'failed', live: false };
  if (outcome === 'cancelled') return { tone: 'neutral', labelKey: 'cancelled', live: false };
  if (outcome === 'budget_exceeded')
    return { tone: 'warning', labelKey: 'budget_exceeded', live: false };
  return { tone: 'neutral', labelKey: 'completed', live: false };
}

const STATUS_LABELS: Record<string, { en: string; de: string }> = {
  running: { en: 'Running', de: 'Läuft' },
  paused: { en: 'Paused', de: 'Pausiert' },
  pending: { en: 'Pending', de: 'Wartet' },
  cancelled: { en: 'Cancelled', de: 'Abgebrochen' },
  failed: { en: 'Failed', de: 'Fehler' },
  success: { en: 'Success', de: 'Erfolg' },
  budget_exceeded: { en: 'Over budget', de: 'Budget' },
  completed: { en: 'Done', de: 'Fertig' },
};

function statusLabel(key: string, lang: string): string {
  const entry = STATUS_LABELS[key] ?? STATUS_LABELS.completed;
  if (!entry) return key;
  return lang.startsWith('de') ? entry.de : entry.en;
}

interface RelativeTimeParts {
  key: 'justNow' | 'minutesAgo' | 'hoursAgo' | 'daysAgo';
  count: number;
}

function relativeTime(ref: Date | string | null, nowMs: number): RelativeTimeParts {
  if (!ref) return { key: 'justNow', count: 0 };
  const d = typeof ref === 'string' ? new Date(ref) : ref;
  const diffMs = Math.max(0, nowMs - d.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return { key: 'justNow', count: 0 };
  if (minutes < 60) return { key: 'minutesAgo', count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: 'hoursAgo', count: hours };
  const days = Math.floor(hours / 24);
  return { key: 'daysAgo', count: days };
}

function pickRefTime(row: GlobalRunRow): Date | string | null {
  return row.endedAt ?? row.startedAt;
}

export function NotificationsPopover() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const globalRuns = useGlobalRuns(50);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows = useMemo(() => {
    const list = globalRuns.data ?? [];
    return list.slice(0, ROW_LIMIT);
  }, [globalRuns.data]);

  // Snapshot "now" while open so labels are stable across renders.
  const nowMs = open ? Date.now() : 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="wisp-btn icon"
        title={t('topBar.notifications', 'Notifications')}
        aria-label={t('topBar.notifications', 'Notifications')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="topbar-notifications-trigger"
      >
        <Bell className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('topBar.notificationsPopover.title', 'Recent activity')}
          data-testid="notifications-popover"
          className="absolute right-0 top-full z-50 mt-1 w-80 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="border-b px-3 py-2 text-sm font-semibold">
            {t('topBar.notificationsPopover.title', 'Recent activity')}
          </div>
          {rows.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-sm text-muted-foreground"
              data-testid="notifications-popover-empty"
            >
              {t('topBar.notificationsPopover.empty', 'No runs yet')}
            </div>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto">
              {rows.map((row) => {
                const presentation = presentRun(row.status, row.outcome);
                const rel = relativeTime(pickRefTime(row), nowMs);
                const relLabel =
                  rel.key === 'justNow'
                    ? t('topBar.notificationsPopover.justNow', 'just now')
                    : t(`topBar.notificationsPopover.${rel.key}`, { count: rel.count });
                return (
                  <li key={row.id}>
                    <Link
                      to={`/projects/${row.projectId}/run/${row.id}`}
                      onClick={() => setOpen(false)}
                      className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                      data-testid={`notification-row-${row.id}`}
                    >
                      <StatusPill tone={presentation.tone} live={presentation.live}>
                        {statusLabel(presentation.labelKey, i18n.resolvedLanguage ?? 'en')}
                      </StatusPill>
                      <span className="min-w-0 flex-1 truncate font-medium">{row.projectName}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{relLabel}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t">
            <Link
              to="/insights"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              data-testid="notifications-popover-view-all"
            >
              {t('topBar.notificationsPopover.viewAll', 'View all insights')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
