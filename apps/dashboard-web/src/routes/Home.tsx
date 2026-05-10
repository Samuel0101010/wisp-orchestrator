import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Activity, CheckCircle2, Clock, Coins, Sparkles } from 'lucide-react';
import { useGlobalRuns, useProjects, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { KpiTile } from '@/components/home/KpiTile';
import { TokenAreaChart } from '@/components/home/TokenAreaChart';
import { OutcomeDonut } from '@/components/home/OutcomeDonut';
import { LiveNowGrid } from '@/components/home/LiveNowGrid';
import { GlobalRunsTable } from '@/components/home/GlobalRunsTable';
import { AgentChat } from '@/components/AgentChat';

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

function classify(r: { status: string; outcome?: string | null }) {
  if (r.status === 'running') return 'running' as const;
  if (r.status === 'paused') return 'paused' as const;
  if (r.status === 'cancelled') return 'cancelled' as const;
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded')
    return 'failure' as const;
  if (r.status === 'completed') return 'success' as const;
  return 'pending' as const;
}

function Sparkline({ data, w = 96, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length) return <span className="text-muted-foreground/50">—</span>;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} className="text-info">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Home() {
  const { t } = useTranslation();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);
  const projects = useProjects();

  const liveRuns = useMemo(
    () => (globalRuns.data ?? []).filter((r) => r.status === 'running' || r.status === 'paused'),
    [globalRuns.data],
  );
  const recentRuns = useMemo(() => (globalRuns.data ?? []).slice(0, 25), [globalRuns.data]);

  const successPercent = summary.data ? Math.round(summary.data.successRate * 100) : 0;
  const tokensByDay = summary.data?.tokensByDay ?? [];
  const outcomeCounts = summary.data?.outcomeCounts ?? {};

  // Per-project rollup
  const perProject = useMemo(() => {
    const byId = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = byId.get(r.projectId) ?? [];
      arr.push(r);
      byId.set(r.projectId, arr);
    });
    return (projects.data ?? []).map((p) => {
      const rs = byId.get(p.id) ?? [];
      const live = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length;
      const failed = rs.filter((r) => classify(r) === 'failure').length;
      const closed = rs.filter((r) => ['success', 'failure', 'cancelled'].includes(classify(r))).length;
      const ok = rs.filter((r) => classify(r) === 'success').length;
      const tok = rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0);
      const buckets = Array.from({ length: 7 }, () => 0);
      rs.forEach((r) => {
        if (!r.startedAt) return;
        const days = Math.floor((Date.now() - new Date(r.startedAt as string).getTime()) / 86_400_000);
        if (days >= 0 && days < 7) buckets[6 - days] = (buckets[6 - days] ?? 0) + 1;
      });
      return {
        project: p,
        runs: rs.length,
        live,
        failed,
        successRate: closed > 0 ? Math.round((ok / closed) * 100) : null,
        tokens: tok,
        spark: buckets,
      };
    }).sort((a, b) => b.live - a.live || b.runs - a.runs);
  }, [globalRuns.data, projects.data]);

  // experiments dropdown — collapsed by default
  const [showVariants, setShowVariants] = useState(false);
  // remember collapsed state
  useEffect(() => {
    try {
      const v = localStorage.getItem('mc-show-variants');
      if (v) setShowVariants(v === '1');
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('mc-show-variants', showVariants ? '1' : '0');
    } catch { /* ignore */ }
  }, [showVariants]);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]" data-testid="mission-control">
      {/* MAIN COLUMN */}
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('home.title', 'Mission Control')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('home.subtitle', 'Live overview of all agent runs across your projects.')}
          </p>
        </header>

        {/* KPI tiles — aggregate across all projects */}
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

        {/* Charts row — token throughput + outcome donut */}
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
              <h2 className="text-sm font-semibold">{t('home.charts.outcomes', 'Run outcomes')}</h2>
              <p className="text-xs text-muted-foreground">
                {t('home.charts.outcomesDesc', 'last 7 days')}
              </p>
            </header>
            <OutcomeDonut counts={outcomeCounts} />
          </div>
        </section>

        {/* Per-project rollup — NEW */}
        <section className="flex flex-col gap-3">
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">By project</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {perProject.length} {perProject.length === 1 ? 'project' : 'projects'}
            </span>
          </header>
          {perProject.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
              No projects yet — create one from the sidebar.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="grid grid-cols-[1fr_72px_64px_84px_64px_56px_36px] items-center gap-3 border-b bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                <span>Project</span>
                <span className="text-right">Runs</span>
                <span className="text-right">Live</span>
                <span className="text-right">Tokens</span>
                <span className="text-right">OK</span>
                <span className="text-right">7d</span>
                <span aria-hidden />
              </div>
              <ul>
                {perProject.map((p) => (
                  <li key={p.project.id} className="border-b last:border-b-0">
                    <Link
                      to={`/projects/${p.project.id}`}
                      className="grid grid-cols-[1fr_72px_64px_84px_64px_56px_36px] items-center gap-3 px-4 py-2.5 hover:bg-muted/50"
                    >
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="truncate text-sm font-medium">{p.project.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{p.project.goal}</span>
                      </div>
                      <span className="text-right font-mono text-sm tabular-nums">{p.runs}</span>
                      <span
                        className={`text-right font-mono text-sm tabular-nums ${p.live > 0 ? 'text-info font-semibold' : 'text-muted-foreground'}`}
                      >
                        {p.live > 0 ? p.live : '—'}
                      </span>
                      <span className="text-right font-mono text-sm tabular-nums">{formatTokensCompact(p.tokens)}</span>
                      <span
                        className={`text-right font-mono text-sm tabular-nums ${p.successRate === null ? 'text-muted-foreground' : p.successRate >= 80 ? 'text-success' : p.successRate >= 50 ? 'text-warning' : 'text-destructive'}`}
                      >
                        {p.successRate === null ? '—' : `${p.successRate}%`}
                      </span>
                      <span className="text-right">
                        <Sparkline data={p.spark} w={48} h={18} />
                      </span>
                      <span className="text-right text-muted-foreground">↗</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Live now */}
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

        {/* Recent runs table */}
        <section className="flex flex-col gap-3" aria-label={t('home.recent.title', 'Recent runs')}>
          <header className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('home.recent.title', 'Recent runs')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('home.recent.subtitle', 'all projects · sortable')}
            </span>
          </header>
          <GlobalRunsTable runs={recentRuns} />
        </section>

        {/* Experiments link — collapsed */}
        <section className="border-t border-dashed border-border/60 pt-3">
          <button
            onClick={() => setShowVariants((v) => !v)}
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70 hover:text-foreground"
          >
            {showVariants ? '↓ hide' : '→ show'} layout experiments (20 variants)
          </button>
          {showVariants && (
            <div className="mt-2 flex flex-col gap-1 font-mono text-[11px] tracking-tight text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="uppercase tracking-[0.18em] text-muted-foreground/80">Set A · 1—8</span>
                <Link to="/mc" className="font-semibold text-foreground hover:underline underline-offset-4">
                  /mc · cycler
                </Link>
                {[
                  ['v1', 'terminal'], ['v2', 'broadsheet'], ['v3', 'radar'], ['v4', 'spec'],
                  ['v5', 'transit'], ['v6', 'poster'], ['v7', 'heatmap'], ['v8', 'console'],
                ].map(([slug, name]) => (
                  <Link key={slug} to={`/mc/${slug}`} className="hover:text-foreground">{name}</Link>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="uppercase tracking-[0.18em] text-muted-foreground/80">Set B · 9—14</span>
                <Link to="/mc/2" className="font-semibold text-foreground hover:underline underline-offset-4">
                  /mc/2 · cycler
                </Link>
                {[
                  ['v9', 'cockpit'], ['v10', 'stream'], ['v11', 'portfolio'],
                  ['v12', 'honeycomb'], ['v13', 'exposé'], ['v14', 'now playing'],
                ].map(([slug, name]) => (
                  <Link key={slug} to={`/mc/${slug}`} className="hover:text-foreground">{name}</Link>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="uppercase tracking-[0.18em] text-muted-foreground/80">Set C · 15—20</span>
                <Link to="/mc/3" className="font-semibold text-foreground hover:underline underline-offset-4">
                  /mc/3 · cycler
                </Link>
                {[
                  ['v15', 'stream²'], ['v16', 'focus'], ['v17', 'dispatch'],
                  ['v18', 'cockpit²'], ['v19', 'timeline'], ['v20', 'inbox'],
                ].map(([slug, name]) => (
                  <Link key={slug} to={`/mc/${slug}`} className="hover:text-foreground">{name}</Link>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {/* RIGHT RAIL — Agent Chat (sticky on xl+) */}
      <aside className="hidden xl:block">
        <div className="sticky top-6 h-[calc(100vh-3.5rem)] overflow-hidden rounded-lg border bg-card">
          <AgentChat compact />
        </div>
      </aside>
    </div>
  );
}
