import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle2, Clock, Coins, Sparkles } from 'lucide-react';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import { KpiTile } from '@/components/home/KpiTile';
import { TokenAreaChart } from '@/components/home/TokenAreaChart';
import { OutcomeDonut } from '@/components/home/OutcomeDonut';
import { LiveNowGrid } from '@/components/home/LiveNowGrid';
import { GlobalRunsTable } from '@/components/home/GlobalRunsTable';

function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function Home() {
  const { t } = useTranslation();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);

  const liveRuns = useMemo(
    () =>
      (globalRuns.data ?? []).filter(
        (r) => r.status === 'running' || r.status === 'paused',
      ),
    [globalRuns.data],
  );
  const recentRuns = useMemo(() => (globalRuns.data ?? []).slice(0, 25), [globalRuns.data]);

  const successPercent = summary.data ? Math.round(summary.data.successRate * 100) : 0;
  const tokensByDay = summary.data?.tokensByDay ?? [];
  const outcomeCounts = summary.data?.outcomeCounts ?? {};

  return (
    <div className="flex flex-col gap-6" data-testid="mission-control">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('home.title', 'Mission Control')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            'home.subtitle',
            'Live overview of all agent runs across your projects.',
          )}
        </p>
      </header>

      <section
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        aria-label={t('home.kpiSection', 'Key metrics')}
      >
        <KpiTile
          label={t('home.kpis.activeRuns', 'Active runs')}
          value={summary.data?.activeCount ?? 0}
          icon={<Activity className="h-4 w-4" />}
          tone="info"
          caption={t('home.kpis.activeCaption', 'currently running or paused')}
          data-testid="kpi-active-runs"
        />
        <KpiTile
          label={t('home.kpis.tokensWindow', 'Tokens · 7 days')}
          value={summary.data?.totalTokens ?? 0}
          format={formatTokensCompact}
          icon={<Coins className="h-4 w-4" />}
          tone="success"
          caption={t('home.kpis.totalRunsCaption', '{{count}} runs in window', {
            count: summary.data?.totalRuns ?? 0,
          })}
          data-testid="kpi-tokens"
        />
        <KpiTile
          label={t('home.kpis.successRate', 'Success rate · 7 days')}
          value={successPercent}
          format={(n) => `${Math.round(n)}%`}
          icon={<CheckCircle2 className="h-4 w-4" />}
          tone={successPercent >= 80 ? 'success' : successPercent >= 50 ? 'warning' : 'destructive'}
          caption={t('home.kpis.successCaption', '{{ok}}/{{total}} successful', {
            ok: outcomeCounts.success ?? 0,
            total: summary.data?.totalRuns ?? 0,
          })}
          data-testid="kpi-success-rate"
        />
        <KpiTile
          label={t('home.kpis.avgDuration', 'Avg duration · 7 days')}
          value={summary.data?.avgDurationMs ?? 0}
          format={formatDuration}
          icon={<Clock className="h-4 w-4" />}
          tone="muted"
          caption={t('home.kpis.avgCaption', 'across completed runs')}
          data-testid="kpi-avg-duration"
        />
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 lg:col-span-2">
          <header className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">
                {t('home.charts.tokenThroughput', 'Token throughput')}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t('home.charts.tokenThroughputDesc', 'last 7 days · all projects')}
              </p>
            </div>
            <Sparkles className="h-4 w-4 text-muted-foreground" />
          </header>
          <TokenAreaChart data={tokensByDay} />
        </div>
        <div className="rounded-lg border bg-card p-5">
          <header className="mb-3">
            <h2 className="text-sm font-semibold">
              {t('home.charts.outcomes', 'Run outcomes')}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t('home.charts.outcomesDesc', 'last 7 days')}
            </p>
          </header>
          <OutcomeDonut counts={outcomeCounts} />
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-label={t('home.live.title', 'Live now')}>
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('home.live.title', 'Live now')}</h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {liveRuns.length} {t('home.live.active', 'active')}
          </span>
        </header>
        <LiveNowGrid
          runs={liveRuns}
          emptyMessage={t('home.live.empty', 'No active runs — kick one off from a project.')}
        />
      </section>

      <section className="flex flex-col gap-3" aria-label={t('home.recent.title', 'Recent runs')}>
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('home.recent.title', 'Recent runs')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('home.recent.subtitle', 'all projects · sortable')}
          </span>
        </header>
        <GlobalRunsTable runs={recentRuns} />
      </section>
    </div>
  );
}
