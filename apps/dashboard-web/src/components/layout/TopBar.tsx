import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Coins } from 'lucide-react';
import { Link, useMatch } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { LanguageToggle } from '@/components/LanguageToggle';
import { computeAggregates, useRunStore } from '@/store/run';

function formatCompactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function TopBar() {
  const { t } = useTranslation();
  const match = useMatch('/projects/:projectId/run/:runId');
  const run = useRunStore((s) => s.run);
  // Subscribe to the small number of scalars we need; compute aggregates from them
  // to avoid returning a fresh object on every render (which would cause an
  // infinite useSyncExternalStore loop).
  const tasks = useRunStore((s) => s.tasks);
  const nowMs = useRunStore((s) => s.nowMs);
  const aggregates = useMemo(() => computeAggregates({ tasks, run, nowMs }), [tasks, run, nowMs]);
  const onRunView = Boolean(match);
  const hasRun = onRunView && run;

  if (!hasRun) {
    return (
      <header className="flex h-14 items-center gap-4 border-b bg-card px-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('topBar.activeRun')}</span>
          <Badge variant="outline">{t('topBar.noRun')}</Badge>
        </div>
        <Separator orientation="vertical" className="h-6" />
        <button type="button" disabled className="text-xs text-muted-foreground">
          <Pause className="mr-2 inline h-4 w-4" />
          {t('buttons.pauseRun')}
        </button>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <Coins className="h-4 w-4 text-muted-foreground" />
          <span className="tabular-nums">0</span>
          <span className="text-xs text-muted-foreground">{t('topBar.tokens')}</span>
          <Separator orientation="vertical" className="h-6" />
          <LanguageToggle />
        </div>
      </header>
    );
  }

  return (
    <header
      className="flex h-14 items-center gap-4 border-b bg-card px-4"
      data-testid="topbar-run-active"
    >
      <Link
        to={`/projects/${match?.params.projectId}/run/${match?.params.runId}`}
        className="flex items-center gap-2 text-sm hover:underline"
      >
        <span className="text-xs text-muted-foreground">{t('topBar.run')}</span>
        <Badge variant="outline" data-testid="topbar-run-status">
          {run.status}
        </Badge>
        <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
      </Link>
      <Separator orientation="vertical" className="h-6" />
      <div className="flex flex-1 items-center gap-4 text-xs">
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-muted-foreground">{t('topBar.time')}</span>
          <div className="relative h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(100, aggregates.percentTime)}%` }}
              data-testid="topbar-time-bar"
            />
          </div>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-muted-foreground">{t('topBar.turns')}</span>
          <div className="relative h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${Math.min(100, aggregates.percentTurns)}%` }}
              data-testid="topbar-turns-bar"
            />
          </div>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2 text-sm">
        <Coins className="h-4 w-4 text-muted-foreground" />
        <span className="tabular-nums" data-testid="topbar-tokens">
          {formatCompactNumber(aggregates.tokensInTotal + aggregates.tokensOutTotal)}
        </span>
        <span className="text-xs text-muted-foreground">{t('topBar.tokens')}</span>
        <Separator orientation="vertical" className="h-6" />
        <LanguageToggle />
      </div>
    </header>
  );
}
