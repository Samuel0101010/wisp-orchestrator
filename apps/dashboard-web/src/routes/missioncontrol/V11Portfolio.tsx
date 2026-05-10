import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useProjects, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

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

function rel(d: string | Date | null | undefined) {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d).getTime() : (d as Date).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

function buckets(runs: GlobalRunRow[], windowDays = 14): number[] {
  const arr = Array.from({ length: windowDays }, () => 0);
  const now = Date.now();
  runs.forEach((r) => {
    if (!r.startedAt) return;
    const days = Math.floor((now - new Date(r.startedAt as string).getTime()) / 86_400_000);
    if (days < 0 || days >= windowDays) return;
    const idx = windowDays - 1 - days;
    arr[idx] = (arr[idx] ?? 0) + r.tokensInTotal + r.tokensOutTotal;
  });
  return arr;
}

function AreaSpark({
  data,
  w = 220,
  h = 50,
  color,
}: {
  data: number[];
  w?: number;
  h?: number;
  color: string;
}) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const top = data.map(
    (v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h * 0.95).toFixed(1)}`,
  );
  const polyline = top.join(' ');
  const area = `M 0,${h} L ${top.join(' L ')} L ${w},${h} Z`;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <path d={area} fill={color} opacity={0.12} />
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface Holding {
  id: string;
  name: string;
  goal: string;
  runs: GlobalRunRow[];
  totalTok: number;
  liveCount: number;
  successRate: number;
  pctChange7d: number;
  series: number[];
}

export function MissionControlV11Portfolio() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'volume' | 'change' | 'live'>('live');

  const holdings: Holding[] = useMemo(() => {
    const projMap = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = projMap.get(r.projectId) ?? [];
      arr.push(r);
      projMap.set(r.projectId, arr);
    });
    return (projects.data ?? []).map((p) => {
      const rs = projMap.get(p.id) ?? [];
      const series = buckets(rs, 14);
      const last7 = series.slice(7).reduce((s, x) => s + x, 0);
      const prev7 = series.slice(0, 7).reduce((s, x) => s + x, 0);
      const pct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : last7 > 0 ? 100 : 0;
      const closed = rs.filter((r) => ['success', 'failure', 'cancelled'].includes(classify(r)));
      const ok = rs.filter((r) => classify(r) === 'success').length;
      return {
        id: p.id,
        name: p.name,
        goal: p.goal,
        runs: rs,
        totalTok: rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0),
        liveCount: rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length,
        successRate: closed.length > 0 ? Math.round((ok / closed.length) * 100) : 0,
        pctChange7d: pct,
        series,
      };
    });
  }, [globalRuns.data, projects.data]);

  const sorted = useMemo(() => {
    const list = [...holdings];
    if (sortBy === 'volume') list.sort((a, b) => b.totalTok - a.totalTok);
    else if (sortBy === 'change') list.sort((a, b) => b.pctChange7d - a.pctChange7d);
    else list.sort((a, b) => b.liveCount - a.liveCount);
    return list;
  }, [holdings, sortBy]);

  const selected = sorted.find((h) => h.id === selectedId) ?? sorted[0] ?? null;

  // Aggregate top hero
  const totalSeries = useMemo(() => {
    const arr = Array.from({ length: 14 }, () => 0);
    holdings.forEach((h) => h.series.forEach((v, i) => (arr[i] = (arr[i] ?? 0) + v)));
    return arr;
  }, [holdings]);

  const last7Total = totalSeries.slice(7).reduce((s, x) => s + x, 0);
  const prev7Total = totalSeries.slice(0, 7).reduce((s, x) => s + x, 0);
  const totalPct = prev7Total > 0 ? ((last7Total - prev7Total) / prev7Total) * 100 : 0;

  return (
    <div
      data-mc-variant="portfolio"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-8 pt-4"
      style={{ background: '#fafafa', color: '#0a0a0a' }}
    >
      <style>{`
        [data-mc-variant="portfolio"] {
          font-family: ui-sans-serif, "Inter", "SF Pro Display", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="portfolio"] .num { font-variant-numeric: tabular-nums; letter-spacing: -0.015em; }
        [data-mc-variant="portfolio"] .row:hover { background: #f4f4f4; }
        [data-mc-variant="portfolio"] .selected { background: #f4f4f4; box-shadow: inset 3px 0 0 #0a0a0a; }
      `}</style>

      <VariantSwitcher tone="paper" set="b" />

      {/* HERO — aggregate */}
      <header className="border-b border-stone-200 pb-6">
        <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.22em] text-stone-500">
          <span>portfolio · agent-harness</span>
          <span>
            {new Date().toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="num text-[88px] font-light leading-none">
              {fmtTok(summary.data?.totalTokens ?? 0)}
              <span className="ml-2 text-2xl font-light text-stone-500">TOK</span>
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <span
                className={`num text-lg font-medium ${totalPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}
              >
                {totalPct >= 0 ? '▲' : '▼'} {Math.abs(totalPct).toFixed(1)}%
              </span>
              <span className="text-[12px] uppercase tracking-[0.18em] text-stone-500">
                vs prior 7 days
              </span>
            </div>
          </div>
          <div className="flex items-end gap-8">
            <Stat k="Active runs" v={String(summary.data?.activeCount ?? 0)} />
            <Stat k="Runs · 7d" v={String(summary.data?.totalRuns ?? 0)} />
            <Stat
              k="Success"
              v={`${Math.round((summary.data?.successRate ?? 0) * 100)}%`}
              tone={
                (summary.data?.successRate ?? 0) >= 0.8
                  ? '#047857'
                  : (summary.data?.successRate ?? 0) >= 0.5
                    ? '#a16207'
                    : '#b91c1c'
              }
            />
            <Stat k="Holdings" v={String(holdings.length)} />
            <div>
              <AreaSpark
                data={totalSeries}
                w={300}
                h={80}
                color={totalPct >= 0 ? '#047857' : '#b91c1c'}
              />
              <div className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                <span>14d</span>
                <span>now</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* HOLDINGS LIST + DETAIL */}
      <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold tracking-tight">Holdings</h2>
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-stone-500">
              <span>sort</span>
              {(['live', 'volume', 'change'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSortBy(s)}
                  className={`rounded-full px-2 py-0.5 ${sortBy === s ? 'bg-stone-900 text-white' : 'hover:text-stone-900'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-md border border-stone-200 bg-white">
            <div className="grid grid-cols-[1fr_220px_72px_72px_56px] items-center gap-3 border-b border-stone-200 px-4 py-2 text-[10px] uppercase tracking-[0.22em] text-stone-500">
              <span>Project</span>
              <span>14d activity</span>
              <span className="text-right">Volume</span>
              <span className="text-right">Δ 7d</span>
              <span className="text-right">Live</span>
            </div>
            {sorted.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] italic text-stone-500">
                No holdings yet. Create a project to start tracking.
              </div>
            ) : (
              <ul>
                {sorted.map((h) => {
                  const isSel = (selected?.id ?? sorted[0]?.id) === h.id;
                  const tone = h.pctChange7d >= 0 ? '#047857' : '#b91c1c';
                  return (
                    <li
                      key={h.id}
                      className={`row grid cursor-pointer grid-cols-[1fr_220px_72px_72px_56px] items-center gap-3 border-b border-stone-100 px-4 py-2.5 ${isSel ? 'selected' : ''}`}
                      onClick={() => setSelectedId(h.id)}
                    >
                      <div className="flex flex-col">
                        <span className="text-[14px] font-medium tracking-tight">{h.name}</span>
                        <span className="truncate font-mono text-[10px] text-stone-500">
                          {h.runs.length} runs · ok {h.successRate}%
                        </span>
                      </div>
                      <div>
                        <AreaSpark data={h.series} w={200} h={36} color={tone} />
                      </div>
                      <span className="num text-right text-[13px] font-medium">
                        {fmtTok(h.totalTok)}
                      </span>
                      <span
                        className={`num text-right text-[13px] font-medium`}
                        style={{ color: tone }}
                      >
                        {h.pctChange7d >= 0 ? '+' : ''}
                        {h.pctChange7d.toFixed(1)}%
                      </span>
                      <span className="text-right">
                        {h.liveCount > 0 ? (
                          <span className="num inline-flex h-6 min-w-[28px] items-center justify-center rounded-full bg-emerald-600 px-2 text-[11px] font-bold text-white">
                            {h.liveCount}
                          </span>
                        ) : (
                          <span className="text-[12px] text-stone-400">—</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* DETAIL */}
        <aside className="lg:sticky lg:top-4">
          {selected ? (
            <div className="rounded-md border border-stone-200 bg-white">
              <div className="flex items-baseline justify-between border-b border-stone-200 px-4 py-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-stone-500">
                    Selected position
                  </div>
                  <h3 className="mt-1 text-xl font-semibold tracking-tight">{selected.name}</h3>
                </div>
                <Link
                  to={`/projects/${selected.id}`}
                  className="rounded-full border border-stone-300 px-3 py-1 text-[11px] uppercase tracking-[0.18em] hover:bg-stone-900 hover:text-white"
                >
                  Open ↗
                </Link>
              </div>
              <div className="px-4 py-3">
                <div className="flex items-baseline gap-3">
                  <span className="num text-3xl font-light leading-none">
                    {fmtTok(selected.totalTok)}
                    <span className="ml-1 text-base text-stone-500">TOK</span>
                  </span>
                  <span
                    className="num text-[14px] font-medium"
                    style={{ color: selected.pctChange7d >= 0 ? '#047857' : '#b91c1c' }}
                  >
                    {selected.pctChange7d >= 0 ? '▲' : '▼'}{' '}
                    {Math.abs(selected.pctChange7d).toFixed(1)}%
                  </span>
                </div>
                <p className="mt-3 line-clamp-3 text-[13px] text-stone-700">{selected.goal}</p>
                <div className="mt-4">
                  <AreaSpark
                    data={selected.series}
                    w={460}
                    h={80}
                    color={selected.pctChange7d >= 0 ? '#047857' : '#b91c1c'}
                  />
                </div>

                <div className="mt-4 grid grid-cols-3 gap-3 text-[12px]">
                  <Cell k="Runs" v={String(selected.runs.length)} />
                  <Cell
                    k="Live now"
                    v={String(selected.liveCount)}
                    tone={selected.liveCount > 0 ? '#047857' : undefined}
                  />
                  <Cell k="Success" v={`${selected.successRate}%`} />
                </div>

                <div className="mt-4 border-t border-stone-100 pt-3">
                  <div className="mb-2 text-[11px] uppercase tracking-[0.22em] text-stone-500">
                    Recent runs
                  </div>
                  <ul className="flex flex-col">
                    {selected.runs.slice(0, 6).map((r) => {
                      const c = classify(r);
                      const tone =
                        c === 'failure'
                          ? '#b91c1c'
                          : c === 'success'
                            ? '#047857'
                            : c === 'running' || c === 'paused'
                              ? '#b45309'
                              : '#52525b';
                      return (
                        <li
                          key={r.id}
                          className="flex items-center gap-2 border-b border-stone-100 py-1.5 text-[12px] last:border-b-0"
                        >
                          <span
                            className="h-1.5 w-1.5 flex-none rounded-full"
                            style={{ background: tone }}
                            aria-hidden
                          />
                          <Link
                            to={`/projects/${r.projectId}/run/${r.id}`}
                            className="flex-1 font-mono text-[11px] hover:underline"
                          >
                            {r.id.slice(0, 8)}
                          </Link>
                          <span className="num text-stone-700">
                            {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                          </span>
                          <span className="text-[11px] text-stone-500">{rel(r.startedAt)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="mt-4 cursor-not-allowed rounded-md border border-dashed border-stone-300 bg-stone-50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-[0.22em] text-stone-500">
                      Ask the team about this project
                    </span>
                    <span className="rounded-full bg-amber-100 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-800">
                      chat · soon
                    </span>
                  </div>
                  <div className="font-mono text-[12px] text-stone-500">
                    @architect · why is volume down vs last week?
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-stone-300 bg-white p-6 text-center text-[13px] italic text-stone-500">
              Select a holding to inspect.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="text-[10px] uppercase tracking-[0.22em] text-stone-500">{k}</span>
      <span className="num mt-1 text-2xl font-medium" style={{ color: tone }}>
        {v}
      </span>
    </div>
  );
}

function Cell({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex flex-col rounded border border-stone-100 bg-stone-50/60 px-3 py-2 leading-none">
      <span className="text-[10px] uppercase tracking-[0.22em] text-stone-500">{k}</span>
      <span className="num mt-1.5 text-lg font-medium" style={{ color: tone }}>
        {v}
      </span>
    </div>
  );
}
