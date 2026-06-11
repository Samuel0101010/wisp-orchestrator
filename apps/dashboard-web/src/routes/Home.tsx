import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Bolt, ChevronRight, FolderOpen, Plus } from 'lucide-react';
import {
  useCreateProject,
  useDailyRunCount,
  useDefaultRepoBase,
  useGlobalRuns,
  useProjects,
  useRunsSummary,
  useTemplates,
} from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { ApiError, apiFetch } from '@/api/client';
import { cn } from '@/lib/utils';
import { defaultRepoPath } from '@/lib/default-repo-path';
import { LiveNowGrid } from '@/components/home/LiveNowGrid';
import { GlobalRunsTable } from '@/components/home/GlobalRunsTable';
import { AgentChat } from '@/components/AgentChat';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { TemplatePicker } from '@/components/TemplatePicker';
import { RepoPathHint } from '@/components/RepoPathHint';

// Charts pull in recharts (~120 kB gzip). Defer them off the initial paint so
// the rest of the dashboard renders first; the charts swap in within a tick.
const TokenAreaChart = lazy(() =>
  import('@/components/home/TokenAreaChart').then((m) => ({ default: m.TokenAreaChart })),
);
const OutcomeDonut = lazy(() =>
  import('@/components/home/OutcomeDonut').then((m) => ({ default: m.OutcomeDonut })),
);

function ChartFallback({ height = 220 }: { height?: number }) {
  return <div aria-busy="true" style={{ height }} />;
}

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

type ToneTrend = 'up' | 'down' | 'flat';
const TREND_GLYPH: Record<ToneTrend, string> = { up: '↗', down: '↘', flat: '→' };

interface KpiSpec {
  id: string;
  label: string;
  value: string;
  suffix?: string;
  trend: ToneTrend;
  tone: '' | 'coral' | 'mint' | 'amber' | 'rose';
  live?: boolean;
}

function KpiCard({ kpi, delay = 0 }: { kpi: KpiSpec; delay?: number }) {
  const trendColor =
    kpi.trend === 'up' ? 'var(--mint)' : kpi.trend === 'down' ? 'var(--rose)' : 'var(--wisp-ink-3)';
  return (
    <div
      className={cn('wisp-card wisp-lift', kpi.tone === 'coral' && 'glow-coral')}
      style={{
        animation: `wisp-fade-up .55s var(--wisp-easing) ${delay}ms backwards`,
        padding: 18,
      }}
      data-testid={`kpi-${kpi.id}`}
    >
      <div className="mb-2.5 flex items-center justify-between">
        <span className="t-eyebrow">{kpi.label}</span>
        <span className="t-mono" style={{ fontSize: 11, color: trendColor }}>
          {TREND_GLYPH[kpi.trend]}
        </span>
      </div>
      <div className="mb-3 flex items-baseline gap-2">
        <span
          style={{
            fontFamily: 'var(--f-display)',
            fontSize: 40,
            lineHeight: 1,
            letterSpacing: '-0.02em',
          }}
        >
          {kpi.value}
        </span>
        {kpi.suffix && (
          <span
            style={{
              fontFamily: 'var(--f-display)',
              fontSize: 28,
              color: 'var(--wisp-ink-3)',
              fontStyle: 'italic',
              lineHeight: 1,
            }}
          >
            {kpi.suffix}
          </span>
        )}
        {kpi.live && (
          <span className="wisp-dot coral pulse" style={{ width: 10, height: 10, marginLeft: 6 }} />
        )}
      </div>
    </div>
  );
}

function Sparkline({ data, w = 96, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length) return <span className="text-[color:var(--wisp-ink-4)]">—</span>;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} className="text-[color:var(--coral)]" aria-hidden>
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

type Period = '24h' | '7d' | '30d';

function HeroHeader({
  activeCount,
  totalToday,
  period,
  onPeriod,
  onNewProject,
  onQuickRun,
}: {
  activeCount: number;
  totalToday: number;
  period: Period;
  onPeriod: (p: Period) => void;
  onNewProject: () => void;
  onQuickRun: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const dateLabel = useMemo(() => {
    try {
      return new Date().toLocaleDateString(lang.startsWith('de') ? 'de-DE' : 'en-US', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
    } catch {
      return new Date().toDateString();
    }
  }, [lang]);
  const greeting = useMemo(() => {
    const hr = new Date().getHours();
    if (hr < 11) return t('home.greeting.morning', 'Good morning.');
    if (hr < 18) return t('home.greeting.afternoon', 'Good afternoon.');
    return t('home.greeting.evening', 'Good evening.');
  }, [t]);

  return (
    <section className="mb-6 flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0 flex-1">
        <div className="t-eyebrow mb-1.5">
          {t('home.eyebrow', 'Mission Control')} · {dateLabel}
        </div>
        <h1
          className="m-0"
          style={{
            fontFamily: 'var(--f-display)',
            fontSize: 28,
            lineHeight: 1.15,
            fontWeight: 400,
            letterSpacing: '-0.02em',
          }}
        >
          {greeting}{' '}
          <span style={{ color: 'var(--wisp-ink-3)', fontStyle: 'italic' }}>
            {t('home.greeting.suffix', '{{count}} runs today.', { count: totalToday })}
          </span>
        </h1>
        <div
          className="mt-2.5 flex flex-wrap items-center gap-1.5"
          style={{ color: 'var(--wisp-ink-3)', fontSize: 13 }}
        >
          {activeCount > 0 ? (
            <>
              <span className="wisp-dot mint pulse" style={{ width: 6, height: 6 }} />
              <span>
                {t('home.greeting.workingShort', '{{count}} agents working', {
                  count: activeCount,
                })}
              </span>
            </>
          ) : (
            <>
              <span className="wisp-dot dim" style={{ width: 6, height: 6 }} />
              <span>{t('home.greeting.idle', 'No live agents · ready when you are.')}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="wisp-segment"
          role="group"
          aria-label={t('home.periodGroup', 'Time period')}
        >
          {(['24h', '7d', '30d'] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              className={cn(period === p && 'on')}
              onClick={() => onPeriod(p)}
              aria-pressed={period === p}
            >
              {p}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="wisp-btn"
          onClick={onNewProject}
          data-testid="home-new-project"
        >
          <Plus className="h-3.5 w-3.5" /> {t('home.actions.newProject', 'New project')}
        </button>
        <button
          type="button"
          className="wisp-btn primary"
          onClick={onQuickRun}
          data-testid="home-quick-run"
        >
          <Bolt className="h-3.5 w-3.5" /> {t('home.actions.quickRun', 'Quick run')}
        </button>
      </div>
    </section>
  );
}

export function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>('7d');
  const summary = useRunsSummary(period === '24h' ? 1 : period === '30d' ? 30 : 7);
  const windowLabel = t(`home.period.${period}`, period);
  const globalRuns = useGlobalRuns(100);
  const projects = useProjects();
  const dailyCounts = useDailyRunCount();
  const { data: templates = [] } = useTemplates();
  const createProject = useCreateProject();

  // New-project dialog state — duplicated from Sidebar.tsx by design so the
  // hero "+ New project" and "Quick run" buttons stay decoupled from the
  // sidebar's internal state.
  const [npOpen, setNpOpen] = useState(false);
  const [npName, setNpName] = useState('');
  const [npGoal, setNpGoal] = useState('');
  const [npRepoPath, setNpRepoPath] = useState('');
  // Until the user edits the repo-path field themselves it auto-fills from
  // the project name (server-suggested base dir + slugified name). The first
  // manual edit flips this and stops the auto-fill for good.
  const [npRepoPathTouched, setNpRepoPathTouched] = useState(false);
  const [npTemplateId, setNpTemplateId] = useState<string | null>(null);
  const repoBase = useDefaultRepoBase();

  const npRepoPathValue =
    npRepoPathTouched || !repoBase.data
      ? npRepoPath
      : defaultRepoPath(repoBase.data.base, repoBase.data.sep, npName);

  const npReset = (): void => {
    setNpName('');
    setNpGoal('');
    setNpRepoPath('');
    setNpRepoPathTouched(false);
    setNpTemplateId(null);
  };
  const npValid = npName.trim() && npGoal.trim() && npRepoPathValue.trim();

  const handleCreateProject = async (): Promise<void> => {
    if (!npValid) return;
    try {
      const project = await createProject.mutateAsync({
        name: npName.trim(),
        goal: npGoal.trim(),
        repoPath: npRepoPathValue.trim(),
      });
      if (npTemplateId) {
        const tpl = templates.find((x) => x.id === npTemplateId);
        if (tpl) {
          try {
            await apiFetch(`/api/projects/${project.id}/team`, {
              method: 'PUT',
              body: JSON.stringify(tpl.team),
            });
          } catch (err) {
            console.warn('template team save failed', err);
          }
        }
      }
      toast({ title: t('newProject.toasts.created'), description: project.name });
      setNpOpen(false);
      npReset();
      // Land on the project overview (Brief tab) — the guided first step — rather
      // than dropping the user into the advanced Team Builder.
      navigate(`/projects/${project.id}`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({
        title: t('newProject.toasts.createFailed'),
        description: msg,
        variant: 'destructive',
      });
    }
  };

  const liveRuns = useMemo(
    () => (globalRuns.data ?? []).filter((r) => r.status === 'running' || r.status === 'paused'),
    [globalRuns.data],
  );
  const recentRuns = useMemo(() => (globalRuns.data ?? []).slice(0, 25), [globalRuns.data]);

  const successPercent = summary.data ? Math.round(summary.data.successRate * 100) : 0;
  const tokensByDay = summary.data?.tokensByDay ?? [];
  const outcomeCounts = summary.data?.outcomeCounts ?? {};
  // "Today" KPI + hero greeting use the real 24h count; the 7-day window total
  // (totalRuns) is what the Run-outcomes card header pairs with successPercent.
  const totalToday = dailyCounts.data?.totalLast24h ?? 0;
  const totalRuns = summary.data?.totalRuns ?? 0;
  const activeCount = summary.data?.activeCount ?? 0;
  const totalTokens = summary.data?.totalTokens ?? 0;
  const avgDuration = summary.data?.avgDurationMs ?? 0;

  // Last-7 token series drives only the tokens KPI trend arrow.
  const tokenSpark = useMemo(() => tokensByDay.map((d) => d?.tokens ?? 0).slice(-7), [tokensByDay]);

  const kpis: KpiSpec[] = [
    {
      id: 'live',
      label: t('home.kpis.activeRuns', 'Live runs'),
      value: String(activeCount),
      trend: activeCount > 0 ? 'up' : 'flat',
      tone: 'coral',
      live: activeCount > 0,
    },
    {
      id: 'today',
      label: t('home.kpis.today', 'Today'),
      value: String(totalToday),
      trend: totalToday > 0 ? 'up' : 'flat',
      tone: '',
    },
    {
      id: 'tokens',
      label: t('home.kpis.tokensWindow', 'Tokens · {{window}}', { window: windowLabel }),
      value: formatTokensCompact(totalTokens),
      trend: tokenSpark.at(-1)! > (tokenSpark.at(-2) ?? 0) ? 'up' : 'flat',
      tone: '',
    },
    {
      id: 'success',
      label: t('home.kpis.successRate', 'Success rate · {{window}}', { window: windowLabel }),
      // Zero runs in the window means "no data", not 0% — a red 0% would
      // suggest failures where none happened (Ø duration shows '—' likewise).
      value: totalRuns > 0 ? `${successPercent}` : '—',
      suffix: totalRuns > 0 ? '%' : undefined,
      trend:
        totalRuns === 0
          ? 'flat'
          : successPercent >= 80
            ? 'up'
            : successPercent >= 50
              ? 'flat'
              : 'down',
      tone:
        totalRuns === 0 ? '' : successPercent >= 80 ? 'mint' : successPercent >= 50 ? '' : 'rose',
    },
    {
      id: 'avg',
      label: t('home.kpis.avgDuration', 'Avg duration · {{window}}', { window: windowLabel }),
      value: formatDuration(avgDuration),
      trend: 'flat',
      tone: '',
    },
  ];

  const perProject = useMemo(() => {
    const byId = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = byId.get(r.projectId) ?? [];
      arr.push(r);
      byId.set(r.projectId, arr);
    });
    return (projects.data ?? [])
      .map((p) => {
        const rs = byId.get(p.id) ?? [];
        const live = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length;
        const failed = rs.filter((r) => classify(r) === 'failure').length;
        const closed = rs.filter((r) =>
          ['success', 'failure', 'cancelled'].includes(classify(r)),
        ).length;
        const ok = rs.filter((r) => classify(r) === 'success').length;
        const tok = rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0);
        const buckets = Array.from({ length: 7 }, () => 0);
        rs.forEach((r) => {
          if (!r.startedAt) return;
          const days = Math.floor(
            (Date.now() - new Date(r.startedAt as string).getTime()) / 86_400_000,
          );
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
      })
      .sort((a, b) => b.live - a.live || b.runs - a.runs);
  }, [globalRuns.data, projects.data]);

  return (
    <div
      className="wisp-fade-up grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]"
      data-testid="mission-control"
    >
      {/* MAIN COLUMN */}
      <div className="flex flex-col gap-6">
        <HeroHeader
          activeCount={activeCount}
          totalToday={totalToday}
          period={period}
          onPeriod={setPeriod}
          onNewProject={() => setNpOpen(true)}
          onQuickRun={() => {
            const id = projects.data?.[0]?.id;
            if (id) navigate(`/projects/${id}/plan`);
            else setNpOpen(true);
          }}
        />

        {/* KPI strip — 5 cards, matches the Wisp design 1:1. */}
        <section
          className="grid grid-cols-2 gap-3.5 md:grid-cols-3 xl:grid-cols-5"
          aria-label={t('home.kpiSection', 'Key metrics')}
          data-testid="home-metric-strip"
        >
          {kpis.map((k, i) => (
            <KpiCard key={k.id} kpi={k} delay={i * 80} />
          ))}
        </section>

        {/* Live operations header — segment + status chip strip. */}
        <section className="flex items-center justify-between">
          <h2
            className="m-0"
            style={{ fontFamily: 'var(--f-head)', fontSize: 18, fontWeight: 500 }}
          >
            {t('home.live.title', 'Live operations')}
          </h2>
          <div className="flex items-center gap-2">
            <span className="wisp-chip">
              <span className="wisp-dot coral pulse" />{' '}
              {t('home.live.runningCount', '{{count}} running', {
                count: liveRuns.filter((r) => r.status === 'running').length,
              })}
            </span>
            <span className="wisp-chip">
              <span className="wisp-dot amber" />{' '}
              {t('home.live.pausedCount', '{{count}} paused', {
                count: liveRuns.filter((r) => r.status === 'paused').length,
              })}
            </span>
          </div>
        </section>

        {/* Live now grid — preserved widget, sits in the design HUD slot. */}
        <LiveNowGrid
          runs={liveRuns}
          emptyMessage={t('home.live.empty', 'No active runs — kick one off from a project.')}
        />

        {/* Charts row — token throughput + outcomes, re-skinned with Wisp card. */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="wisp-card lg:col-span-2">
            <header className="mb-3 flex items-center justify-between">
              <div>
                <div className="t-eyebrow">
                  {t('home.charts.tokenThroughput', 'Token throughput')}
                </div>
                <div style={{ fontFamily: 'var(--f-head)', fontSize: 16, fontWeight: 500 }}>
                  <span style={{ fontFamily: 'var(--f-display)', fontSize: 22 }}>
                    {formatTokensCompact(totalTokens)}
                  </span>
                  <span style={{ color: 'var(--wisp-ink-3)' }}>
                    {' '}
                    ·{' '}
                    {t('home.charts.tokenThroughputDesc', 'last {{window}} · all projects', {
                      window: windowLabel,
                    })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="wisp-chip">
                  <span className="wisp-dot coral" />
                  {t('home.charts.tokensIn', 'in')}
                </span>
                <span className="wisp-chip">
                  <span className="wisp-dot dim" />
                  {t('home.charts.tokensOut', 'out')}
                </span>
              </div>
            </header>
            <div style={{ minHeight: 220 }}>
              <Suspense fallback={<ChartFallback />}>
                <TokenAreaChart data={tokensByDay} />
              </Suspense>
            </div>
          </div>
          <div className="wisp-card">
            <header className="mb-3">
              <div className="t-eyebrow">{t('home.charts.outcomes', 'Run outcomes')}</div>
              <div style={{ fontFamily: 'var(--f-head)', fontSize: 16, fontWeight: 500 }}>
                {totalRuns}{' '}
                <span style={{ color: 'var(--wisp-ink-3)' }}>
                  · {successPercent}% {t('home.charts.successRate', 'success')} ·{' '}
                  {t('home.charts.window', 'last {{window}}', { window: windowLabel })}
                </span>
              </div>
            </header>
            <div style={{ minHeight: 220 }}>
              <Suspense fallback={<ChartFallback />}>
                <OutcomeDonut counts={outcomeCounts} />
              </Suspense>
            </div>
          </div>
        </section>

        {/* Per-project rollup — design table with sparklines + dots */}
        <section className="flex flex-col gap-3">
          <header className="flex items-end justify-between">
            <div className="flex flex-col gap-0.5">
              <h2
                className="m-0"
                style={{ fontFamily: 'var(--f-head)', fontSize: 18, fontWeight: 500 }}
              >
                {t('home.byProject.title')}
              </h2>
              <span className="t-faint text-xs">
                {t('home.byProject.subtitle', 'OK = all-time success rate · all runs')}
              </span>
            </div>
            <span className="t-faint text-xs tabular-nums">
              {t('home.byProject.count', { count: perProject.length })}
            </span>
          </header>
          {perProject.length === 0 ? (
            <div className="wisp-card flex h-24 items-center justify-center text-sm text-[color:var(--wisp-ink-3)]">
              {t('home.byProject.empty')}
            </div>
          ) : (
            <div className="wisp-card overflow-hidden overflow-x-auto p-0">
              <div className="grid min-w-[560px] grid-cols-[1.6fr_72px_64px_84px_64px_72px_36px] items-center gap-3 border-b border-[color:var(--wisp-hairline)] px-4 py-2.5">
                {[
                  { label: t('home.byProject.cols.project') },
                  { label: t('home.byProject.cols.runs') },
                  { label: t('home.byProject.cols.live') },
                  { label: t('home.byProject.cols.tokens') },
                  {
                    label: t('home.byProject.cols.ok'),
                    title: t('home.byProject.cols.okTitle', 'All-time success rate (all runs)'),
                  },
                  {
                    label: t('home.byProject.cols.sevenDay'),
                    title: t('home.byProject.cols.sevenDayTitle', 'Runs per day, last 7 days'),
                  },
                  { label: '' },
                ].map((h, i) => (
                  <span
                    key={i}
                    className="t-eyebrow"
                    style={{ textAlign: i === 0 ? 'left' : 'right' }}
                    title={h.title}
                  >
                    {h.label}
                  </span>
                ))}
              </div>
              <ul>
                {perProject.map((p, i) => (
                  <li
                    key={p.project.id}
                    className={cn(
                      'border-[color:var(--wisp-hairline)]',
                      i < perProject.length - 1 && 'border-b',
                    )}
                  >
                    <Link
                      to={`/projects/${p.project.id}`}
                      className="grid min-w-[560px] grid-cols-[1.6fr_72px_64px_84px_64px_72px_36px] items-center gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--wisp-glass-hover)]"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderOpen className="h-3.5 w-3.5 text-[color:var(--wisp-ink-3)]" />
                        <span
                          className="truncate"
                          style={{ fontFamily: 'var(--f-head)', fontSize: 13.5 }}
                        >
                          {p.project.name}
                        </span>
                        {p.live > 0 && (
                          <span
                            className="wisp-chip coral"
                            style={{ padding: '0 6px', fontSize: 10 }}
                          >
                            <span
                              className="wisp-dot coral pulse"
                              style={{ width: 5, height: 5 }}
                            />
                            live
                          </span>
                        )}
                      </div>
                      <span className="t-mono text-right" style={{ fontSize: 13 }}>
                        {p.runs}
                      </span>
                      <span
                        className="t-mono text-right"
                        style={{
                          fontSize: 13,
                          color: p.live > 0 ? 'var(--coral)' : 'var(--wisp-ink-4)',
                        }}
                      >
                        {p.live > 0 ? p.live : '—'}
                      </span>
                      <span className="t-mono text-right" style={{ fontSize: 13 }}>
                        {formatTokensCompact(p.tokens)}
                      </span>
                      <span
                        className="t-mono text-right"
                        style={{
                          fontSize: 13,
                          color:
                            p.successRate === null
                              ? 'var(--wisp-ink-4)'
                              : p.successRate >= 80
                                ? 'var(--mint)'
                                : p.successRate <= 40
                                  ? 'var(--rose)'
                                  : 'var(--wisp-ink-2)',
                        }}
                      >
                        {p.successRate === null ? '—' : `${p.successRate}%`}
                      </span>
                      <div className="flex justify-end">
                        <Sparkline data={p.spark} w={64} h={20} />
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 justify-self-end text-[color:var(--wisp-ink-4)]" />
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Recent runs table — preserved */}
        <section className="flex flex-col gap-3" aria-label={t('home.recent.title', 'Recent runs')}>
          <header className="flex items-center justify-between">
            <h2
              className="m-0"
              style={{ fontFamily: 'var(--f-head)', fontSize: 18, fontWeight: 500 }}
            >
              {t('home.recent.title', 'Recent runs')}
            </h2>
            <span className="t-faint text-xs">
              {t('home.recent.subtitle', 'all projects · sortable')}
            </span>
          </header>
          <GlobalRunsTable runs={recentRuns} />
        </section>
      </div>

      {/* RIGHT RAIL — Agent Chat (sticky on xl+) */}
      <aside className="hidden xl:block">
        <div className="wisp-card sticky top-6 h-[calc(100vh-3.5rem)] overflow-hidden p-0">
          <AgentChat compact />
        </div>
      </aside>

      {/* New-project dialog — wired to hero "+ New project" and "Quick run". */}
      <Dialog
        open={npOpen}
        onOpenChange={(o) => {
          setNpOpen(o);
          if (!o) npReset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('newProject.title')}</DialogTitle>
            <DialogDescription>{t('newProject.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="home-np-name">{t('newProject.fields.name')}</Label>
              <Input
                id="home-np-name"
                placeholder={t('newProject.fields.namePlaceholder')}
                value={npName}
                onChange={(e) => setNpName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('newProject.fields.template')}</Label>
              <TemplatePicker selectedId={npTemplateId} onSelect={setNpTemplateId} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="home-np-goal">{t('newProject.fields.goal')}</Label>
              <Textarea
                id="home-np-goal"
                rows={3}
                placeholder={
                  npTemplateId
                    ? t(`templates.${npTemplateId}.exampleGoal`, {
                        defaultValue:
                          templates.find((tpl) => tpl.id === npTemplateId)?.suggestedGoals[0] ??
                          t('newProject.fields.goalPlaceholder'),
                      })
                    : t('newProject.fields.goalPlaceholder')
                }
                value={npGoal}
                onChange={(e) => setNpGoal(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="home-np-repo">{t('newProject.fields.repoPath')}</Label>
              <Input
                id="home-np-repo"
                placeholder={t('newProject.fields.repoPathPlaceholder')}
                value={npRepoPathValue}
                onChange={(e) => {
                  setNpRepoPathTouched(true);
                  setNpRepoPath(e.target.value);
                }}
              />
              <p className="text-2xs text-muted-foreground">
                {t('newProject.fields.repoPathHelp')}
              </p>
              <RepoPathHint path={npRepoPathValue} />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleCreateProject} disabled={!npValid || createProject.isPending}>
              {createProject.isPending ? t('buttons.creating') : t('buttons.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
