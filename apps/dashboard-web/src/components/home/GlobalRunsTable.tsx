import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { fmtRel } from '@/lib/fmt-rel';
import { cn } from '@/lib/utils';
import type { GlobalRunRow } from '@/api/queries';

type SortKey = 'startedAt' | 'duration' | 'tokens' | 'project';
type SortDir = 'asc' | 'desc';

function durationMs(r: GlobalRunRow): number {
  if (!r.startedAt) return 0;
  const start = typeof r.startedAt === 'string' ? new Date(r.startedAt) : r.startedAt;
  const end = r.endedAt
    ? typeof r.endedAt === 'string'
      ? new Date(r.endedAt)
      : r.endedAt
    : new Date();
  return end.getTime() - start.getTime();
}

function tokensTotal(r: GlobalRunRow): number {
  return (r.tokensInTotal ?? 0) + (r.tokensOutTotal ?? 0);
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '—';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface GlobalRunsTableProps {
  runs: GlobalRunRow[];
}

export function GlobalRunsTable({ runs }: GlobalRunsTableProps) {
  const { t, i18n } = useTranslation();
  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const arr = [...runs];
    arr.sort((a, b) => {
      const av =
        sortKey === 'tokens'
          ? tokensTotal(a)
          : sortKey === 'duration'
            ? durationMs(a)
            : sortKey === 'project'
              ? a.projectName.toLowerCase()
              : a.startedAt
                ? typeof a.startedAt === 'string'
                  ? new Date(a.startedAt).getTime()
                  : a.startedAt.getTime()
                : 0;
      const bv =
        sortKey === 'tokens'
          ? tokensTotal(b)
          : sortKey === 'duration'
            ? durationMs(b)
            : sortKey === 'project'
              ? b.projectName.toLowerCase()
              : b.startedAt
                ? typeof b.startedAt === 'string'
                  ? new Date(b.startedAt).getTime()
                  : b.startedAt.getTime()
                : 0;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [runs, sortKey, sortDir]);

  const toggleSort = (k: SortKey): void => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'project' ? 'asc' : 'desc');
    }
  };

  const SortHeader = ({
    k,
    children,
    align,
  }: {
    k: SortKey;
    children: React.ReactNode;
    align?: 'right';
  }) => (
    <th
      scope="col"
      className={cn(
        'cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      onClick={() => toggleSort(k)}
      aria-sort={sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span
        className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}
      >
        {children}
        <ArrowUpDown className={cn('h-3 w-3', sortKey === k ? 'text-foreground' : 'opacity-40')} />
      </span>
    </th>
  );

  if (runs.length === 0) {
    return (
      <div
        className="flex h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
        data-testid="global-runs-empty"
      >
        {t('home.recentRuns.empty')}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="global-runs-table">
          <thead className="border-b bg-muted/30">
            <tr>
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {t('home.recentRuns.cols.run')}
              </th>
              <SortHeader k="project">{t('home.recentRuns.cols.project')}</SortHeader>
              <th
                scope="col"
                className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
              >
                {t('home.recentRuns.cols.status')}
              </th>
              <SortHeader k="startedAt">{t('home.recentRuns.cols.started')}</SortHeader>
              <SortHeader k="duration" align="right">
                {t('home.recentRuns.cols.duration')}
              </SortHeader>
              <SortHeader k="tokens" align="right">
                {t('home.recentRuns.cols.tokens')}
              </SortHeader>
              <th scope="col" className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr
                key={r.id}
                className="border-b transition-colors last:border-b-0 hover:bg-muted/40"
                data-testid={`global-run-row-${r.id}`}
              >
                <td className="px-3 py-2 font-mono text-xs">{r.id.slice(0, 8)}</td>
                <td className="px-3 py-2">
                  <Link to={`/projects/${r.projectId}`} className="text-foreground hover:underline">
                    {r.projectName}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <StatusDotBadge status={r.status} pulse={r.status === 'running'} />
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                  {r.startedAt ? fmtRel(r.startedAt, i18n.language) : '—'}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatDuration(durationMs(r))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatTokens(tokensTotal(r))}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button asChild size="sm" variant="ghost">
                    <Link
                      to={`/projects/${r.projectId}/run/${r.id}`}
                      aria-label={`Open run ${r.id.slice(0, 8)}`}
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t bg-muted/20 px-3 py-1.5 text-xs2 text-muted-foreground">
        {t('home.recentRuns.footer', { count: sorted.length })} · {t('topBar.missionControl')}
      </div>
    </div>
  );
}
