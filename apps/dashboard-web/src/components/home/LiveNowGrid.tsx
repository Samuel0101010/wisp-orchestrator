import { Link } from 'react-router-dom';
import { Clock, Coins } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { cn } from '@/lib/utils';
import type { GlobalRunRow } from '@/api/queries';

function formatDuration(start: string | Date | null, nowMs: number): string {
  if (!start) return '—';
  const d = typeof start === 'string' ? new Date(start) : start;
  const ms = nowMs - d.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export interface LiveNowGridProps {
  runs: GlobalRunRow[];
  emptyMessage: string;
}

export function LiveNowGrid({ runs, emptyMessage }: LiveNowGridProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  // Tick every second so the live duration updates without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (runs.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
        data-testid="live-now-empty"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {runs.map((r) => (
        <LiveRunCard key={r.id} run={r} nowMs={nowMs} />
      ))}
    </div>
  );
}

function LiveRunCard({ run, nowMs }: { run: GlobalRunRow; nowMs: number }) {
  const { t } = useTranslation();
  const tokens = (run.tokensInTotal ?? 0) + (run.tokensOutTotal ?? 0);
  const isLive = run.status === 'running';
  return (
    <Link
      to={`/projects/${run.projectId}/run/${run.id}`}
      className={cn(
        'group relative block rounded-lg border bg-card p-4 transition-colors hover:border-info/40',
        isLive && 'border-beam',
      )}
      data-testid={`live-run-${run.id}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{run.projectName}</span>
          <span className="font-mono text-xs text-muted-foreground">/ {run.id.slice(0, 8)}</span>
        </div>
        <StatusDotBadge status={run.status} pulse={isLive} />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          <span className="tabular-nums text-foreground">
            {formatDuration(run.startedAt, nowMs)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Coins className="h-3.5 w-3.5" />
          <span className="tabular-nums text-foreground">{formatTokens(tokens)}</span>
          <span>{t('topBar.tokens')}</span>
        </span>
        <span className="tabular-nums">
          {run.turnsTotal} {t('home.live.turns')}
        </span>
      </div>
    </Link>
  );
}
