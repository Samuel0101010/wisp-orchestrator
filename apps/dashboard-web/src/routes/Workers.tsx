import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, CheckCircle2, ChevronRight, Pause } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import { useWorkers, useWorkerRuns, useRunWorker, type WorkerSummary } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorBanner } from '@/components/ui/error-banner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StatusPill } from '@/components/ui/status-pill';
import { statusLabel, statusMeta } from '@/lib/status-labels';

const MIN_PAINT_MS = 800;

function usePendingPaint(name: string, isApiPending: boolean): boolean {
  const [, setTick] = useState(0);
  const startsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (isApiPending && name) startsRef.current.set(name, Date.now());
  }, [isApiPending, name]);
  const start = startsRef.current.get(name);
  const withinWindow = start != null && Date.now() - start < MIN_PAINT_MS;
  const paintPending = isApiPending || withinWindow;
  useEffect(() => {
    if (!paintPending) return;
    const startedAt = startsRef.current.get(name);
    if (startedAt == null) return;
    const remaining = Math.max(0, MIN_PAINT_MS - (Date.now() - startedAt));
    const t = setTimeout(() => {
      if (!isApiPending) startsRef.current.delete(name);
      setTick((x) => x + 1);
    }, remaining);
    return () => clearTimeout(t);
  }, [paintPending, isApiPending, name]);
  return paintPending;
}

function fmtTs(ts: number | string | null | undefined): string {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function RunsPanel({ name }: { name: string }) {
  const { t } = useTranslation();
  const runsQ = useWorkerRuns(name);
  if (runsQ.isLoading) {
    return (
      <div className="space-y-2" aria-label={t('workers.loadingRuns')}>
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (runsQ.error) {
    return (
      <ErrorBanner
        title={t('workers.runsFailed')}
        message={t('errors.retryHint')}
        onRetry={() => runsQ.refetch()}
      />
    );
  }
  const rows = runsQ.data ?? [];
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('workers.noRuns')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="pb-1 pr-4">{t('workers.cols.id')}</th>
            <th className="pb-1 pr-4">{t('workers.cols.started')}</th>
            <th className="pb-1 pr-4">{t('workers.cols.ended')}</th>
            <th className="pb-1 pr-4">{t('workers.cols.status')}</th>
            <th className="pb-1">{t('workers.cols.result')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const meta = statusMeta(r.status);
            const StatusIcon = meta.Icon;
            const resultStr = r.resultJson != null ? JSON.stringify(r.resultJson) : null;
            return (
              <tr key={r.id} className="border-b border-border last:border-0">
                <td className="py-1.5 pr-4 font-mono text-xs text-muted-foreground">
                  {r.id.slice(0, 8)}
                </td>
                <td className="py-1.5 pr-4 text-xs tabular-nums">{fmtTs(r.startedAt)}</td>
                <td className="py-1.5 pr-4 text-xs tabular-nums">{fmtTs(r.endedAt)}</td>
                <td className="py-1.5 pr-4">
                  <StatusPill
                    tone={meta.tone}
                    icon={<StatusIcon className={meta.live ? 'size-3 animate-spin' : 'size-3'} />}
                  >
                    {statusLabel(r.status, t)}
                  </StatusPill>
                </td>
                <td className="py-1.5 font-mono text-xs text-muted-foreground">
                  {r.errorReason ? (
                    <span
                      className="block max-w-[32ch] truncate text-destructive"
                      title={r.errorReason}
                    >
                      {r.errorReason}
                    </span>
                  ) : resultStr != null ? (
                    <span className="block max-w-[40ch] truncate" title={resultStr}>
                      {resultStr}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunButton({
  name,
  isApiPending,
  onRun,
}: {
  name: string;
  isApiPending: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  const paintPending = usePendingPaint(name, isApiPending);
  return (
    <button
      onClick={onRun}
      disabled={paintPending}
      aria-label={t('workers.actions.runWorker', { name })}
      className="rounded border border-border bg-card px-3 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {paintPending ? t('workers.actions.running') : t('workers.actions.runNow')}
    </button>
  );
}

export function WorkersRoute() {
  const { t } = useTranslation();
  const workersQ = useWorkers();
  const runWorker = useRunWorker();
  const [selected, setSelected] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Surface the run-history panel when a worker is selected — it renders below
  // the table and would otherwise stay off-screen. Honor reduced-motion.
  useEffect(() => {
    if (!selected || !panelRef.current) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panelRef.current.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  }, [selected]);

  if (workersQ.isLoading) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{t('workers.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('workers.loading')}</p>
        </header>
        <div className="space-y-2 rounded-md border border-border p-4">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      </div>
    );
  }
  if (workersQ.error) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{t('workers.title')}</h1>
        </header>
        <ErrorBanner
          title={t('workers.loadFailed')}
          message={t('errors.retryHint')}
          onRetry={() => workersQ.refetch()}
        />
      </div>
    );
  }
  const workers = workersQ.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('workers.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('workers.subtitle', { count: workers.length })}
        </p>
      </header>

      {workers.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-6 w-6" />}
          title={t('workers.emptyTitle')}
          description={t('workers.emptyDescription')}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2">{t('workers.cols.name')}</th>
                <th className="px-4 py-2">{t('workers.cols.schedule')}</th>
                <th className="px-4 py-2">{t('workers.cols.enabled')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {workers.map((w: WorkerSummary) => (
                <tr
                  key={w.name}
                  className={
                    'border-b border-border last:border-0 transition-colors ' +
                    (selected === w.name ? 'bg-accent/60' : 'hover:bg-accent/40')
                  }
                >
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setSelected(selected === w.name ? null : w.name)}
                      aria-expanded={selected === w.name}
                      aria-controls={`worker-history-${w.name}`}
                      className="focus-ring -mx-1 flex items-center gap-1.5 rounded px-1 font-mono font-semibold"
                    >
                      <ChevronRight
                        className={
                          'size-3.5 shrink-0 text-muted-foreground transition-transform ' +
                          (selected === w.name ? 'rotate-90' : '')
                        }
                        aria-hidden
                      />
                      {w.name}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs2 tracking-wide text-muted-foreground">
                    {w.cronSpec}
                  </td>
                  <td className="px-4 py-2.5">
                    {w.enabled ? (
                      <StatusPill tone="success" icon={<CheckCircle2 className="size-3" />}>
                        {t('workers.badge.enabled')}
                      </StatusPill>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="cursor-help">
                            <StatusPill tone="neutral" icon={<Pause className="size-3" />}>
                              {t('workers.badge.disabled')}
                            </StatusPill>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{t('workers.disabledTooltip')}</TooltipContent>
                      </Tooltip>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <RunButton
                      name={w.name}
                      isApiPending={runWorker.isPending && runWorker.variables === w.name}
                      onRun={() => {
                        runWorker.mutate(w.name, {
                          onError: () =>
                            toast({
                              variant: 'destructive',
                              title: t('workers.runWorkerFailed'),
                              description: t('errors.retryHint'),
                            }),
                        });
                        setSelected(w.name);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div
          ref={panelRef}
          id={`worker-history-${selected}`}
          className="space-y-3 rounded-md border border-border bg-card p-4"
        >
          <h2 className="text-sm font-semibold">
            {t('workers.history')} <span className="text-muted-foreground">·</span>{' '}
            <span className="font-mono">{selected}</span>
          </h2>
          <RunsPanel name={selected} />
        </div>
      )}
    </div>
  );
}
