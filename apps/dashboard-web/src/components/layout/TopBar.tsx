import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Coins, Activity, Search } from 'lucide-react';
import { useMatch } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { LanguageToggle } from '@/components/LanguageToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { AnimatedCounter } from '@/components/AnimatedCounter';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { useDailyRunCount } from '@/api/queries';
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
  const tasks = useRunStore((s) => s.tasks);
  const nowMs = useRunStore((s) => s.nowMs);
  const aggregates = useMemo(() => computeAggregates({ tasks, run, nowMs }), [tasks, run, nowMs]);
  const dailyCounts = useDailyRunCount();
  const onRunView = Boolean(match);
  const hasRun = onRunView && run;

  // Right-hand cluster — same on all pages. ⌘K trigger + Theme + Language.
  const rightCluster = (
    <div className="ml-auto flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
        onClick={() => {
          const evt = new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: true,
            bubbles: true,
          });
          window.dispatchEvent(evt);
        }}
        aria-label={t('topBar.openCommandPalette')}
        data-testid="topbar-cmdk-trigger"
      >
        <Search className="h-3.5 w-3.5" />
        <kbd className="hidden rounded border bg-muted px-1 py-0 text-[10px] sm:inline">⌘K</kbd>
      </Button>
      <Separator orientation="vertical" className="h-6" />
      <ThemeToggle />
      <Separator orientation="vertical" className="h-6" />
      <LanguageToggle />
    </div>
  );

  if (!hasRun) {
    const totalToday = dailyCounts.data?.totalLast24h ?? 0;
    return (
      <header
        className="topbar-blur sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-card/80 px-5"
        data-testid="topbar"
      >
        <Breadcrumbs />
        <Separator orientation="vertical" className="h-6" />
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5" />
            <AnimatedCounter
              value={totalToday}
              durationMs={600}
              className="font-medium text-foreground"
            />
            <span>{t('topBar.today')}</span>
          </span>
        </div>
        {rightCluster}
      </header>
    );
  }

  return (
    <header
      className="topbar-blur sticky top-0 z-30 flex h-14 items-center gap-4 border-b bg-card/80 px-5"
      data-testid="topbar-run-active"
    >
      <Breadcrumbs />
      <StatusDotBadge
        status={run.status}
        pulse={run.status === 'running'}
        data-testid="topbar-run-status"
      />
      <Separator orientation="vertical" className="h-6" />
      <button type="button" disabled className="text-xs text-muted-foreground">
        <Pause className="mr-2 inline h-4 w-4" />
        {t('buttons.pauseRun')}
      </button>
      <div className="flex flex-1 items-center gap-4 text-xs">
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-muted-foreground">{t('topBar.time')}</span>
          <div className="relative h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-info transition-all duration-300 ease-out"
              style={{ width: `${Math.min(100, aggregates.percentTime)}%` }}
              data-testid="topbar-time-bar"
            />
          </div>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-muted-foreground">{t('topBar.turns')}</span>
          <div className="relative h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-info transition-all duration-300 ease-out"
              style={{ width: `${Math.min(100, aggregates.percentTurns)}%` }}
              data-testid="topbar-turns-bar"
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Coins className="h-4 w-4 text-muted-foreground" />
        <AnimatedCounter
          value={aggregates.tokensInTotal + aggregates.tokensOutTotal}
          format={formatCompactNumber}
          className="font-medium"
          data-testid="topbar-tokens"
        />
        <span className="text-xs text-muted-foreground">{t('topBar.tokens')}</span>
      </div>
      {rightCluster}
    </header>
  );
}
