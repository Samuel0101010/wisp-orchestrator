import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Coins, Search } from 'lucide-react';
import { useMatch } from 'react-router-dom';
import { Breadcrumbs } from '@/components/layout/Breadcrumbs';
import { NotificationsPopover } from '@/components/layout/NotificationsPopover';
import { LanguageToggle } from '@/components/LanguageToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { AnimatedCounter } from '@/components/AnimatedCounter';
import { useDailyRunCount, useGlobalRuns } from '@/api/queries';
import { computeAggregates, useRunStore } from '@/store/run';
import { cn } from '@/lib/utils';

function formatCompactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const ONLINE_TONES = ['coral', 'sky', 'mint', 'amber', 'rose'] as const;

function dispatchCmdK() {
  const evt = new KeyboardEvent('keydown', {
    key: 'k',
    metaKey: true,
    bubbles: true,
  });
  window.dispatchEvent(evt);
}

/**
 * Top bar — Wisp design parity. Layout: Breadcrumbs / CmdK search bar /
 * online-team chip + notifications + theme + language. On the run view a
 * progress strip with time + turns bars + token counter replaces the search
 * bar so the live numbers stay in sight.
 */
export function TopBar() {
  const { t } = useTranslation();
  const match = useMatch('/projects/:projectId/run/:runId');
  const run = useRunStore((s) => s.run);
  const tasks = useRunStore((s) => s.tasks);
  const nowMs = useRunStore((s) => s.nowMs);
  const aggregates = useMemo(() => computeAggregates({ tasks, run, nowMs }), [tasks, run, nowMs]);
  const dailyCounts = useDailyRunCount();
  const globalRuns = useGlobalRuns(50);

  const onRunView = Boolean(match);
  const hasRun = onRunView && run;

  const live = useMemo(
    () =>
      (globalRuns.data ?? []).filter(
        (r) => r.status === 'running' || r.status === 'paused' || r.status === 'pending',
      ),
    [globalRuns.data],
  );
  const onlineNames = useMemo(() => {
    const set = new Set<string>();
    live.forEach((r) => {
      if (set.size >= 5) return;
      set.add(r.projectName ?? r.projectId);
    });
    return Array.from(set);
  }, [live]);

  const searchBar = (
    <button
      type="button"
      onClick={dispatchCmdK}
      className="group flex max-w-[520px] flex-1 items-center gap-2 rounded-[10px] border border-[color:var(--wisp-hairline)] bg-[color:var(--wisp-glass)] px-3.5 py-1.5 font-[var(--f-head)] text-sm-tight text-[color:var(--wisp-ink-3)] transition-colors hover:border-[color:var(--wisp-hairline-bright)] hover:bg-[color:var(--wisp-glass-hover)]"
      data-testid="topbar-cmdk-trigger"
    >
      <Search className="h-3.5 w-3.5 text-[color:var(--wisp-ink-3)]" />
      <span className="flex-1 text-left">
        {t('topBar.searchPlaceholder', 'Search projects, agents, runs…')}
      </span>
      <span className="wisp-kbd">⌘K</span>
    </button>
  );

  const rightCluster = (
    <div className="ml-auto flex items-center gap-2">
      {onlineNames.length > 0 && (
        <div
          className="flex items-center gap-1.5 rounded-full border border-[color:var(--wisp-hairline)] px-2.5 py-1"
          data-testid="topbar-online-team"
        >
          <span className="wisp-dot mint pulse" style={{ width: 6, height: 6 }} />
          <span className="t-mono" style={{ fontSize: 11, color: 'var(--wisp-ink-2)' }}>
            {t('topBar.activeNow', '{{count}} active', { count: onlineNames.length })}
          </span>
          <div className="wisp-av-stack ml-1">
            {onlineNames.slice(0, 5).map((name, i) => (
              <span
                key={name}
                className={cn('wisp-av', ONLINE_TONES[i % ONLINE_TONES.length])}
                style={{ width: 22, height: 22, fontSize: 10 }}
                title={name}
              >
                {name.slice(0, 2).toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      )}
      <NotificationsPopover />
      <ThemeToggle />
      <LanguageToggle />
    </div>
  );

  if (!hasRun) {
    const totalToday = dailyCounts.data?.totalLast24h ?? 0;
    return (
      <header
        className="wisp-aurora-scope relative z-[2] flex h-14 items-center gap-5 border-b border-[color:var(--wisp-hairline)] bg-[color:var(--wisp-topbar-bg)] px-5 backdrop-blur-[20px]"
        data-testid="topbar"
      >
        <Breadcrumbs />
        <div className="flex items-center gap-2 text-xs text-[color:var(--wisp-ink-3)]">
          <Activity className="h-3.5 w-3.5" />
          <AnimatedCounter
            value={totalToday}
            durationMs={600}
            className="text-[color:var(--wisp-ink)] font-medium"
          />
          <span>{t('topBar.today')}</span>
        </div>
        {searchBar}
        {rightCluster}
      </header>
    );
  }

  return (
    <header
      className="wisp-aurora-scope relative z-[2] flex h-14 items-center gap-5 border-b border-[color:var(--wisp-hairline)] bg-[color:var(--wisp-topbar-bg)] px-5 backdrop-blur-[20px]"
      data-testid="topbar-run-active"
    >
      <Breadcrumbs />
      <StatusDotBadge
        status={run.status}
        pulse={run.status === 'running'}
        data-testid="topbar-run-status"
      />
      <div className="flex flex-1 items-center gap-4 text-xs">
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-[color:var(--wisp-ink-3)]">{t('topBar.time')}</span>
          <div className="wisp-bar mint relative max-w-40 flex-1">
            <i
              data-testid="topbar-time-bar"
              style={
                {
                  ['--w' as never]: Math.min(1, aggregates.percentTime / 100),
                  transform: `scaleX(${Math.min(1, aggregates.percentTime / 100)})`,
                } as React.CSSProperties
              }
            />
          </div>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <span className="w-12 text-[color:var(--wisp-ink-3)]">{t('topBar.turns')}</span>
          <div className="wisp-bar relative max-w-40 flex-1">
            <i
              data-testid="topbar-turns-bar"
              style={
                {
                  ['--w' as never]: Math.min(1, aggregates.percentTurns / 100),
                  transform: `scaleX(${Math.min(1, aggregates.percentTurns / 100)})`,
                } as React.CSSProperties
              }
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Coins className="h-4 w-4 text-[color:var(--wisp-ink-3)]" />
        <AnimatedCounter
          value={aggregates.tokensInTotal + aggregates.tokensOutTotal}
          format={formatCompactNumber}
          className="font-medium"
          data-testid="topbar-tokens"
        />
        <span className="text-xs text-[color:var(--wisp-ink-3)]">{t('topBar.tokens')}</span>
      </div>
      {rightCluster}
    </header>
  );
}
