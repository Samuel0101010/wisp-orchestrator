import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useProjects, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const HUES = [218, 158, 18, 268, 38, 338, 198, 88];

function classify(r: { status: string; outcome?: string | null }) {
  if (r.status === 'running') return 'running' as const;
  if (r.status === 'paused') return 'paused' as const;
  if (r.status === 'cancelled') return 'cancelled' as const;
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded')
    return 'failure' as const;
  if (r.status === 'completed') return 'success' as const;
  return 'pending' as const;
}

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtDur(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function durationOf(r: GlobalRunRow): number {
  if (!r.startedAt) return 0;
  const start = new Date(r.startedAt as string).getTime();
  const end = r.endedAt ? new Date(r.endedAt as string).getTime() : Date.now();
  return Math.max(0, (end - start) / 1000);
}

interface RunBar {
  run: GlobalRunRow;
  startMs: number;
  endMs: number;
  hue: number;
  durationSec: number;
  isAnomaly: boolean;
  anomalyReason: string;
}

export function MissionControlV19Timeline() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);
  const [windowHours, setWindowHours] = useState(72);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');

  const projectHue = useMemo(() => {
    const m = new Map<string, number>();
    (projects.data ?? []).forEach((p, i) => m.set(p.id, HUES[i % HUES.length] ?? 200));
    return m;
  }, [projects.data]);

  const now = Date.now();
  const windowMs = windowHours * 3_600_000;
  const windowStart = now - windowMs;

  // Anomaly detection: compute per-project mean+stddev duration of completed runs
  const projectStats = useMemo(() => {
    const m = new Map<string, { mean: number; std: number; n: number }>();
    const byProj = new Map<string, number[]>();
    (globalRuns.data ?? []).forEach((r) => {
      if (r.status !== 'completed' || !r.endedAt) return;
      const dur = durationOf(r);
      const arr = byProj.get(r.projectId) ?? [];
      arr.push(dur);
      byProj.set(r.projectId, arr);
    });
    byProj.forEach((arr, k) => {
      if (arr.length < 2) {
        m.set(k, { mean: arr[0] ?? 0, std: 0, n: arr.length });
        return;
      }
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
      m.set(k, { mean, std: Math.sqrt(variance), n: arr.length });
    });
    return m;
  }, [globalRuns.data]);

  const swimLanes = useMemo(() => {
    const byProj = new Map<string, RunBar[]>();
    (globalRuns.data ?? []).forEach((r) => {
      if (!r.startedAt) return;
      const startMs = new Date(r.startedAt as string).getTime();
      const endMs = r.endedAt ? new Date(r.endedAt as string).getTime() : now;
      if (endMs < windowStart) return;
      const stats = projectStats.get(r.projectId);
      const dur = durationOf(r);
      let isAnomaly = false;
      let anomalyReason = '';
      if (stats && stats.std > 0 && stats.n >= 3 && r.status === 'completed') {
        const z = (dur - stats.mean) / stats.std;
        if (z > 2) {
          isAnomaly = true;
          anomalyReason = `${z.toFixed(1)}σ slower than peers`;
        }
      }
      if (classify(r) === 'failure') {
        isAnomaly = true;
        anomalyReason = anomalyReason || 'failed run';
      }
      const bar: RunBar = {
        run: r,
        startMs: Math.max(startMs, windowStart),
        endMs: Math.min(endMs, now),
        hue: projectHue.get(r.projectId) ?? 200,
        durationSec: dur,
        isAnomaly,
        anomalyReason,
      };
      const arr = byProj.get(r.projectName) ?? [];
      arr.push(bar);
      byProj.set(r.projectName, arr);
    });
    return Array.from(byProj.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [globalRuns.data, projectHue, windowStart, now, projectStats]);

  // cost area chart underneath — bin by hour
  const buckets = Math.min(48, Math.max(8, Math.floor(windowHours)));
  const tokenChart = useMemo(() => {
    const arr = Array.from({ length: buckets }, () => 0);
    const bucketMs = windowMs / buckets;
    (globalRuns.data ?? []).forEach((r) => {
      if (!r.startedAt) return;
      const t = new Date(r.startedAt as string).getTime();
      if (t < windowStart || t > now) return;
      const idx = Math.min(buckets - 1, Math.floor((t - windowStart) / bucketMs));
      arr[idx] = (arr[idx] ?? 0) + r.tokensInTotal + r.tokensOutTotal;
    });
    return arr;
  }, [globalRuns.data, windowStart, now, windowMs, buckets]);

  const selected = selectedRunId
    ? (globalRuns.data ?? []).find((r) => r.id === selectedRunId) ?? null
    : null;

  function pctOf(t: number): number {
    return Math.max(0, Math.min(100, ((t - windowStart) / windowMs) * 100));
  }

  const anomalies = swimLanes.flatMap(([, bars]) => bars.filter((b) => b.isAnomaly));

  return (
    <div
      data-mc-variant="timeline"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_auto_1fr_auto] [color-scheme:dark]"
      style={{ background: '#0a0a0d', color: '#e4e4e7' }}
    >
      <style>{`
        [data-mc-variant="timeline"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="timeline"] .bar { transition: transform 120ms; cursor: pointer; }
        [data-mc-variant="timeline"] .bar:hover { transform: translateY(-1px); filter: brightness(1.2); }
        @keyframes ping {
          0%, 100% { opacity: 0.6; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        [data-mc-variant="timeline"] .anom { animation: ping 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="timeline"] .anom { animation: none; }
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="c" />
      </div>

      {/* TOP — title + window controls + KPIs */}
      <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b border-white/5 px-6 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
            timeline · time-axis primary · {anomalies.length > 0 ? `${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} flagged` : 'system nominal'}
          </div>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">All projects, in time</h1>
            <div className="flex rounded-full border border-white/10 p-0.5 font-mono text-[10px] uppercase tracking-[0.18em]">
              {[6, 24, 72, 168].map((h) => (
                <button
                  key={h}
                  onClick={() => setWindowHours(h)}
                  className={`rounded-full px-2.5 py-0.5 ${windowHours === h ? 'bg-purple-500 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100'}`}
                >
                  {h < 24 ? `${h}h` : `${h / 24}d`}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-end gap-6 font-mono text-[11px] tabular-nums">
          {[
            { k: 'live', v: summary.data?.activeCount ?? 0, tone: '#22d3ee' },
            { k: 'lanes', v: swimLanes.length },
            { k: 'tok·win', v: fmtTok(tokenChart.reduce((s, x) => s + x, 0)) },
            { k: 'anom', v: anomalies.length, tone: anomalies.length > 0 ? '#fb7185' : '#71717a' },
          ].map((s) => (
            <div key={s.k} className="flex flex-col items-end leading-none">
              <span className="text-[9px] uppercase tracking-[0.22em] text-zinc-500">{s.k}</span>
              <span className="mt-1 text-[15px]" style={{ color: s.tone }}>
                {s.v}
              </span>
            </div>
          ))}
        </div>
      </header>

      {/* BODY: timeline + side panel */}
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_320px] gap-px bg-white/5">
        <main className="flex min-h-0 flex-col overflow-auto bg-[#0a0a0d]">
          {/* time axis */}
          <div className="sticky top-0 z-10 border-b border-white/10 bg-[#0a0a0d] px-6 py-2">
            <div className="grid grid-cols-[180px_1fr] items-center gap-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">project</div>
              <div className="relative h-5">
                {Array.from({ length: 8 }).map((_, i) => {
                  const left = (i / 7) * 100;
                  const offsetMs = windowMs - (i / 7) * windowMs;
                  const offsetH = offsetMs / 3_600_000;
                  const label =
                    i === 7 ? 'now' : offsetH < 24 ? `${Math.round(offsetH)}h` : `${(offsetH / 24).toFixed(0)}d`;
                  return (
                    <div
                      key={i}
                      className="absolute -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500"
                      style={{ left: `${left}%` }}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* swim lanes */}
          {swimLanes.length === 0 ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-zinc-500">
              no runs in {windowHours < 24 ? `${windowHours}h` : `${windowHours / 24}d`} window
            </div>
          ) : (
            <ul className="px-6 py-3">
              {swimLanes.map(([name, bars]) => {
                const hue = bars[0]?.hue ?? 200;
                return (
                  <li
                    key={name}
                    className="grid grid-cols-[180px_1fr] items-center gap-4 border-b border-white/5 py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="block h-2 w-2 flex-none rounded-full" style={{ background: `hsl(${hue} 60% 55%)` }} />
                      <span className="truncate text-[13px] font-medium text-zinc-100">{name}</span>
                      <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                        {bars.length}
                      </span>
                    </div>
                    <div className="relative h-9 rounded-md bg-white/3">
                      {/* grid lines */}
                      {Array.from({ length: 8 }).map((_, i) => (
                        <span
                          key={i}
                          className="absolute top-0 bottom-0 w-px bg-white/5"
                          style={{ left: `${(i / 7) * 100}%` }}
                        />
                      ))}
                      {bars.map((b) => {
                        const left = pctOf(b.startMs);
                        const right = pctOf(b.endMs);
                        const width = Math.max(0.4, right - left);
                        const c = classify(b.run);
                        const baseColor = `hsl(${b.hue} 60% 55%)`;
                        const fill =
                          c === 'failure'
                            ? '#fb7185'
                            : c === 'running' || c === 'paused'
                              ? baseColor
                              : c === 'success'
                                ? `hsl(${b.hue} 50% 60% / 0.7)`
                                : '#71717a';
                        return (
                          <button
                            key={b.run.id}
                            onClick={() => setSelectedRunId(b.run.id)}
                            onMouseEnter={() => setSelectedRunId(b.run.id)}
                            className={`bar absolute top-1.5 bottom-1.5 rounded ${b.isAnomaly ? 'anom' : ''}`}
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              minWidth: 4,
                              background: fill,
                              outline: b.isAnomaly ? '2px solid #fb7185' : selectedRunId === b.run.id ? '2px solid #fafafa' : 'none',
                              outlineOffset: 1,
                            }}
                            title={`${b.run.id.slice(0, 8)} · ${fmtDur(b.durationSec)}${b.anomalyReason ? ` · ${b.anomalyReason}` : ''}`}
                          />
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {/* COST AREA chart underneath */}
          <div className="mt-auto border-t border-white/10 bg-[#08080b] px-6 py-3">
            <div className="grid grid-cols-[180px_1fr] items-end gap-4">
              <div className="flex flex-col">
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  token throughput
                </span>
                <span className="mt-1 font-mono tabular-nums text-zinc-300">
                  {fmtTok(tokenChart.reduce((s, x) => s + x, 0))}
                </span>
              </div>
              <svg viewBox={`0 0 ${buckets * 10} 60`} className="block h-[60px] w-full" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="cost-grad" x1="0" y1="1" x2="0" y2="0">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity="0" />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.6" />
                  </linearGradient>
                </defs>
                {(() => {
                  const max = Math.max(...tokenChart, 1);
                  const pts = tokenChart.map((v, i) => `${i * 10},${60 - (v / max) * 56}`).join(' ');
                  return (
                    <>
                      <polygon
                        points={`0,60 ${pts} ${(buckets - 1) * 10},60`}
                        fill="url(#cost-grad)"
                      />
                      <polyline points={pts} fill="none" stroke="#a78bfa" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    </>
                  );
                })()}
              </svg>
            </div>
          </div>
        </main>

        {/* SIDE — selected detail + chat composer */}
        <aside className="flex min-h-0 flex-col bg-[#08080b]">
          <header className="border-b border-white/5 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">selected</span>
              {selected && (
                <button
                  onClick={() => setSelectedRunId(null)}
                  className="font-mono text-[10px] text-zinc-500 hover:text-zinc-200"
                >
                  ← all
                </button>
              )}
            </div>
            <div className="mt-1 truncate text-[12px] text-zinc-300">
              {selected ? `run ${selected.id.slice(0, 8)}` : `${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'}`}
            </div>
          </header>

          <div className="flex-1 overflow-auto px-4 py-3">
            {selected ? (
              <div className="flex flex-col gap-3">
                <Link
                  to={`/projects/${selected.projectId}/run/${selected.id}`}
                  className="text-[13px] font-medium text-zinc-100 hover:underline"
                >
                  {selected.projectName} ↗
                </Link>
                <dl className="grid grid-cols-2 gap-y-2 font-mono text-[11px]">
                  <Row k="status" v={selected.status} />
                  <Row k="duration" v={fmtDur(durationOf(selected))} />
                  <Row k="tok·in" v={fmtTok(selected.tokensInTotal)} />
                  <Row k="tok·out" v={fmtTok(selected.tokensOutTotal)} />
                  <Row k="turns" v={String(selected.turnsTotal)} />
                  <Row k="budget" v={`${selected.budgetMinutes}m / ${selected.budgetTurns}t`} />
                </dl>
                {(() => {
                  const stats = projectStats.get(selected.projectId);
                  if (!stats || stats.n < 3) return null;
                  const z = stats.std > 0 ? (durationOf(selected) - stats.mean) / stats.std : 0;
                  const tone = z > 2 ? '#fb7185' : z > 1 ? '#fbbf24' : '#86efac';
                  return (
                    <div className="rounded-md border border-white/10 bg-white/3 p-2.5">
                      <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                        peer comparison
                      </div>
                      <div className="mt-1.5 text-[12px] text-zinc-300">
                        Among {stats.n} completed runs of this project, this run is{' '}
                        <span className="font-mono tabular-nums" style={{ color: tone }}>
                          {z >= 0 ? '+' : ''}{z.toFixed(1)}σ
                        </span>{' '}
                        from the mean ({fmtDur(stats.mean)}).
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : anomalies.length > 0 ? (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-rose-300">
                  flagged
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {anomalies.slice(0, 6).map((b) => (
                    <li key={b.run.id}>
                      <button
                        onClick={() => setSelectedRunId(b.run.id)}
                        className="block w-full rounded-md border border-rose-400/30 bg-rose-400/5 p-2.5 text-left hover:bg-rose-400/10"
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="text-[12px] font-medium text-zinc-100">{b.run.projectName}</span>
                          <span className="font-mono text-[10px] text-zinc-500">{b.run.id.slice(0, 6)}</span>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-rose-300">{b.anomalyReason}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="font-mono text-[12px] italic text-zinc-500">
                hover a bar to inspect.
              </div>
            )}
          </div>

          <div className="border-t border-white/5 p-3">
            <div className="rounded-lg border border-white/10 bg-white/3 p-2.5 focus-within:border-purple-400/40">
              <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                <span>{selected ? `re: run ${selected.id.slice(0, 6)}` : 'ask the team'}</span>
                <span className="rounded-full bg-amber-400/15 px-1.5 py-px text-amber-300">soon</span>
              </div>
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                rows={3}
                placeholder={selected ? 'why is this run an outlier?' : 'why was the busy period yesterday at 14:30?'}
                className="w-full resize-none border-0 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
              />
            </div>
          </div>
        </aside>
      </div>

      <footer className="border-t border-white/5 px-6 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
        v19 · timeline · 6h · 24h · 3d · 7d windows · z-score &gt; 2σ flags anomalies · click to inspect
      </footer>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">{k}</dt>
      <dd className="text-right tabular-nums text-zinc-200">{v}</dd>
    </>
  );
}
