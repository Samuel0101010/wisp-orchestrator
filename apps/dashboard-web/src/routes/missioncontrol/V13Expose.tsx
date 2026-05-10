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

const TONE = {
  running: '#06b6d4',
  paused: '#f59e0b',
  success: '#10b981',
  failure: '#ef4444',
  cancelled: '#94a3b8',
  pending: '#94a3b8',
};

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

function MicroBars({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex h-9 items-end gap-[3px]" aria-hidden>
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * 36);
        return (
          <span
            key={i}
            className="flex-1"
            style={{ height: h, background: color, opacity: v ? 0.8 : 0.15, borderRadius: 1 }}
          />
        );
      })}
    </div>
  );
}

interface Tile {
  id: string;
  name: string;
  goal: string;
  runs: GlobalRunRow[];
  liveRuns: GlobalRunRow[];
  recentRuns: GlobalRunRow[];
  series: number[];
  totalTok: number;
  successRate: number;
  primaryState: keyof typeof TONE;
}

export function MissionControlV13Expose() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const tiles: Tile[] = useMemo(() => {
    const projMap = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = projMap.get(r.projectId) ?? [];
      arr.push(r);
      projMap.set(r.projectId, arr);
    });
    return (projects.data ?? [])
      .map((p) => {
        const rs = projMap.get(p.id) ?? [];
        const buckets = Array.from({ length: 14 }, () => 0);
        rs.forEach((r) => {
          if (!r.startedAt) return;
          const days = Math.floor(
            (Date.now() - new Date(r.startedAt as string).getTime()) / 86_400_000,
          );
          if (days < 0 || days >= 14) return;
          buckets[13 - days] = (buckets[13 - days] ?? 0) + (r.tokensInTotal + r.tokensOutTotal);
        });
        const live = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused');
        const closed = rs.filter((r) => ['success', 'failure', 'cancelled'].includes(classify(r)));
        const ok = rs.filter((r) => classify(r) === 'success').length;
        const fail = rs.filter((r) => classify(r) === 'failure').length;
        const primaryState: keyof typeof TONE =
          live.length > 0
            ? 'running'
            : fail > ok
              ? 'failure'
              : closed.length > 0
                ? 'success'
                : 'pending';
        return {
          id: p.id,
          name: p.name,
          goal: p.goal,
          runs: rs,
          liveRuns: live,
          recentRuns: rs.slice(0, 5),
          series: buckets,
          totalTok: rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0),
          successRate: closed.length > 0 ? Math.round((ok / closed.length) * 100) : 0,
          primaryState,
        };
      })
      .sort((a, b) => {
        // live first, then volume
        if ((a.liveRuns.length > 0 ? 1 : 0) !== (b.liveRuns.length > 0 ? 1 : 0)) {
          return (b.liveRuns.length > 0 ? 1 : 0) - (a.liveRuns.length > 0 ? 1 : 0);
        }
        return b.totalTok - a.totalTok;
      });
  }, [globalRuns.data, projects.data]);

  return (
    <div
      data-mc-variant="expose"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-6 pb-32 pt-4"
      style={{
        background: '#fafaf9',
        color: '#0a0a0a',
        backgroundImage:
          'radial-gradient(circle at 20% 0%, rgba(6,182,212,0.08), transparent 40%), radial-gradient(circle at 80% 100%, rgba(245,158,11,0.05), transparent 40%)',
      }}
    >
      <style>{`
        [data-mc-variant="expose"] {
          font-family: ui-sans-serif, "Inter", "SF Pro Display", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="expose"] .tile {
          transition: transform 280ms cubic-bezier(0.32,0.72,0,1), box-shadow 280ms cubic-bezier(0.32,0.72,0,1);
          transform-origin: center;
          cursor: pointer;
          background: rgba(255,255,255,0.85);
          backdrop-filter: blur(12px);
        }
        [data-mc-variant="expose"] .tile:hover {
          transform: translateY(-3px) scale(1.012);
          box-shadow: 0 12px 32px rgba(15,23,42,0.10), 0 4px 8px rgba(15,23,42,0.05);
        }
        [data-mc-variant="expose"] .tile.expanded {
          transform: scale(1);
          box-shadow: 0 24px 64px rgba(15,23,42,0.18), 0 8px 16px rgba(15,23,42,0.08);
        }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="expose"] .tile { transition: none; }
        }
      `}</style>

      <VariantSwitcher tone="paper" set="b" />

      <header className="mb-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-500">
          mission control · exposé
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">All projects, in one glance</h1>
        <p className="mt-1 max-w-prose text-[13px] text-stone-600">
          One tile per project, sorted by activity. Hover lifts; click expands inline. The floating
          dock at the bottom is the cross-project aggregate; it stays glued whatever you scroll to.
        </p>
      </header>

      {/* Tile grid */}
      {tiles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-stone-300 bg-white px-6 py-16 text-center text-[13px] italic text-stone-500">
          No projects yet. Create one from the sidebar to populate the wall.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {tiles.map((t) => {
            const tone = TONE[t.primaryState];
            const isExpanded = expandedId === t.id;
            return (
              <article
                key={t.id}
                className={`tile relative overflow-hidden rounded-2xl border border-stone-200 ${isExpanded ? 'expanded col-span-1 md:col-span-2 xl:col-span-3' : ''}`}
                onClick={() => setExpandedId(isExpanded ? null : t.id)}
                aria-expanded={isExpanded}
              >
                {/* color bar at top — hairline-thin (1px), allowed */}
                <div className="h-px w-full" style={{ background: tone, opacity: 0.5 }} />
                <div className="grid grid-cols-[1fr_auto] gap-3 px-5 pb-3 pt-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="block h-2 w-2 rounded-full"
                        style={{
                          background: tone,
                          boxShadow: t.liveRuns.length > 0 ? `0 0 0 3px ${tone}26` : 'none',
                        }}
                      />
                      <h2 className="truncate text-[16px] font-semibold tracking-tight">
                        {t.name}
                      </h2>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[12px] text-stone-600">{t.goal}</div>
                  </div>
                  <div className="text-right">
                    <span
                      className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]"
                      style={{ background: `${tone}1f`, color: tone }}
                    >
                      {t.primaryState}
                    </span>
                  </div>
                </div>

                {/* 4 micro-widgets */}
                <div className="grid grid-cols-2 gap-3 px-5 pb-4">
                  <Widget
                    label="Live runs"
                    sub={t.liveRuns.length > 0 ? `tracking ${t.liveRuns.length}` : 'idle'}
                  >
                    <span className="text-3xl font-light leading-none tabular-nums">
                      {t.liveRuns.length}
                    </span>
                  </Widget>

                  <Widget label="Tokens · 14d" sub={fmtTok(t.totalTok)}>
                    <MicroBars data={t.series} color={tone} />
                  </Widget>

                  <Widget label="Recent runs" sub={`${t.runs.length} on file`}>
                    {t.recentRuns.length === 0 ? (
                      <span className="text-[11px] italic text-stone-500">none</span>
                    ) : (
                      <ul className="flex flex-col gap-0.5 text-[11px]">
                        {t.recentRuns.slice(0, 3).map((r) => {
                          const c = classify(r);
                          return (
                            <li key={r.id} className="flex items-center gap-1.5">
                              <span
                                className="h-1.5 w-1.5 flex-none rounded-full"
                                style={{ background: TONE[c] }}
                              />
                              <Link
                                to={`/projects/${r.projectId}/run/${r.id}`}
                                className="flex-1 truncate font-mono tracking-tight hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {r.id.slice(0, 8)}
                              </Link>
                              <span className="font-mono text-stone-500">{rel(r.startedAt)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Widget>

                  <Widget label="Success" sub={`${t.runs.length} runs`}>
                    <SuccessRing pct={t.successRate} color={tone} />
                  </Widget>
                </div>

                {/* expanded extras */}
                {isExpanded && (
                  <div
                    className="border-t border-stone-200 bg-stone-50/60 px-5 py-4"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
                        all runs · this project
                      </span>
                      <Link
                        to={`/projects/${t.id}`}
                        className="rounded-full bg-stone-900 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-white hover:bg-stone-700"
                      >
                        open project ↗
                      </Link>
                    </div>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_300px]">
                      <ul className="rounded-lg border border-stone-200 bg-white">
                        {t.runs.length === 0 ? (
                          <li className="px-4 py-6 italic text-stone-500">No runs.</li>
                        ) : (
                          t.runs.slice(0, 8).map((r) => {
                            const c = classify(r);
                            return (
                              <li
                                key={r.id}
                                className="flex items-center gap-2 border-b border-stone-100 px-4 py-2 text-[12px] last:border-b-0"
                              >
                                <span
                                  className="h-2 w-2 flex-none rounded-full"
                                  style={{ background: TONE[c] }}
                                />
                                <span
                                  className="font-mono text-[10px] uppercase tracking-[0.18em]"
                                  style={{ color: TONE[c], minWidth: 64 }}
                                >
                                  {c}
                                </span>
                                <Link
                                  to={`/projects/${r.projectId}/run/${r.id}`}
                                  className="flex-1 font-mono text-[11px] hover:underline"
                                >
                                  {r.id.slice(0, 10)}
                                </Link>
                                <span className="font-mono tabular-nums text-stone-700">
                                  {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                                </span>
                                <span className="font-mono text-stone-500">{r.turnsTotal}t</span>
                                <span className="font-mono text-stone-500">{rel(r.startedAt)}</span>
                              </li>
                            );
                          })
                        )}
                      </ul>
                      <div className="cursor-not-allowed rounded-lg border border-dashed border-stone-300 bg-white p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
                            agent chat · {t.name}
                          </span>
                          <span className="rounded-full bg-amber-100 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-800">
                            soon
                          </span>
                        </div>
                        <div className="font-mono text-[12px] text-stone-500">
                          @architect · summarise this project's last week
                        </div>
                        <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-stone-500">
                          <span>cmd+enter · placeholder</span>
                          <span>v13 · exposé</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* FLOATING DOCK — cross-project aggregate */}
      <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
        <div
          className="flex items-center gap-6 rounded-full border border-stone-200 px-6 py-2.5 shadow-lg"
          style={{
            background: 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(20px) saturate(140%)',
          }}
        >
          <div className="flex items-center gap-2">
            <span className="block h-2 w-2 animate-pulse rounded-full bg-cyan-500" />
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
              aggregate
            </span>
          </div>
          <Stat
            k="Active"
            v={String(summary.data?.activeCount ?? 0)}
            tone={(summary.data?.activeCount ?? 0) > 0 ? '#0e7490' : undefined}
          />
          <Stat k="Runs · 7d" v={String(summary.data?.totalRuns ?? 0)} />
          <Stat k="Tokens · 7d" v={fmtTok(summary.data?.totalTokens ?? 0)} />
          <Stat k="OK" v={`${Math.round((summary.data?.successRate ?? 0) * 100)}%`} />
          <Stat k="Projects" v={String(tiles.length)} />
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">
            v13 · exposé
          </span>
        </div>
      </div>
    </div>
  );
}

function Widget({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-stone-100 bg-stone-50/40 p-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
          {label}
        </span>
        {sub && <span className="font-mono text-[9px] text-stone-500">{sub}</span>}
      </div>
      <div className="flex min-h-[40px] items-end">{children}</div>
    </div>
  );
}

function SuccessRing({ pct, color }: { pct: number; color: string }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="flex items-center gap-2">
      <svg width={42} height={42} viewBox="0 0 42 42">
        <circle cx={21} cy={21} r={r} fill="none" stroke="rgba(15,23,42,0.08)" strokeWidth={4} />
        <circle
          cx={21}
          cy={21}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeDasharray={`${dash} ${c - dash}`}
          strokeDashoffset={c / 4}
          transform="rotate(-90 21 21)"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-2xl font-light leading-none tabular-nums">{pct}%</span>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex flex-col items-center leading-none">
      <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-stone-500">{k}</span>
      <span className="mt-0.5 text-base font-semibold tabular-nums" style={{ color: tone }}>
        {v}
      </span>
    </div>
  );
}
