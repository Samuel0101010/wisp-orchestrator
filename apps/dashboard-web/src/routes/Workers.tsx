import { useState } from 'react';
import { useWorkers, useWorkerRuns, useRunWorker, type WorkerSummary, type WorkerRunRow } from '@/api/queries';

function statusColor(status: WorkerRunRow['status']): string {
  if (status === 'ok') return 'text-green-600 dark:text-green-400';
  if (status === 'failed') return 'text-destructive';
  return 'text-yellow-600 dark:text-yellow-400';
}

function fmtTs(ts: number | string | null | undefined): string {
  if (ts == null) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function RunsPanel({ name }: { name: string }) {
  const runsQ = useWorkerRuns(name);
  if (runsQ.isLoading) return <div className="text-sm text-muted-foreground">Loading runs…</div>;
  const rows = runsQ.data ?? [];
  if (rows.length === 0) return <div className="text-sm text-muted-foreground">No runs yet.</div>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th className="pb-1 pr-4">ID</th>
          <th className="pb-1 pr-4">Started</th>
          <th className="pb-1 pr-4">Ended</th>
          <th className="pb-1 pr-4">Status</th>
          <th className="pb-1">Result / Error</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-border last:border-0">
            <td className="py-1.5 pr-4 font-mono text-xs text-muted-foreground">{r.id.slice(0, 8)}</td>
            <td className="py-1.5 pr-4 text-xs">{fmtTs(r.startedAt)}</td>
            <td className="py-1.5 pr-4 text-xs">{fmtTs(r.endedAt)}</td>
            <td className={`py-1.5 pr-4 text-xs font-medium ${statusColor(r.status)}`}>{r.status}</td>
            <td className="py-1.5 font-mono text-xs text-muted-foreground">
              {r.errorReason
                ? <span className="text-destructive">{r.errorReason}</span>
                : r.resultJson != null
                  ? <span>{JSON.stringify(r.resultJson).slice(0, 120)}</span>
                  : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WorkersRoute() {
  const workersQ = useWorkers();
  const runWorker = useRunWorker();
  const [selected, setSelected] = useState<string | null>(null);

  if (workersQ.isLoading) return <div className="text-muted-foreground">Loading workers…</div>;
  if (workersQ.error) return <div className="text-destructive">Failed to load workers</div>;
  const workers = workersQ.data ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {workers.length} background worker{workers.length === 1 ? '' : 's'} registered
        </p>
      </header>

      <div className="rounded border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Schedule</th>
              <th className="px-4 py-2">Enabled</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {workers.map((w: WorkerSummary) => (
              <tr
                key={w.name}
                className={
                  'cursor-pointer border-b border-border last:border-0 transition-colors hover:bg-accent/40 ' +
                  (selected === w.name ? 'bg-accent/60' : '')
                }
                onClick={() => setSelected(selected === w.name ? null : w.name)}
              >
                <td className="px-4 py-2.5 font-mono font-semibold">{w.name}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{w.cronSpec}</td>
                <td className="px-4 py-2.5">
                  <span className={
                    'rounded px-2 py-0.5 text-xs font-medium ' +
                    (w.enabled
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-secondary text-secondary-foreground')
                  }>
                    {w.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      runWorker.mutate(w.name);
                      setSelected(w.name);
                    }}
                    disabled={runWorker.isPending}
                    className="rounded border border-border bg-card px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
                  >
                    {runWorker.isPending && runWorker.variables === w.name ? 'Running…' : 'Run now'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="space-y-3 rounded border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">
            Run history — <span className="font-mono">{selected}</span>
          </h2>
          <RunsPanel name={selected} />
        </div>
      )}
    </div>
  );
}
