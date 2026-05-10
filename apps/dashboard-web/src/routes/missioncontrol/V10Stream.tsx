import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useProjects, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const PROJECT_HUES = [218, 158, 18, 268, 38, 338, 198, 88];

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

function rel(d: string | Date | number | null | undefined) {
  if (!d && d !== 0) return '—';
  const t =
    typeof d === 'number'
      ? d
      : typeof d === 'string'
        ? new Date(d).getTime()
        : (d as Date).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

interface Entry {
  ts: number;
  kind: 'started' | 'ended' | 'paused';
  run: GlobalRunRow;
  hue: number;
}

function entryLine(e: Entry): { verb: string; tone: string } {
  const c = classify(e.run);
  if (e.kind === 'started') return { verb: 'launched a run', tone: 'text-stone-700' };
  if (e.kind === 'paused') return { verb: 'paused — rate limit window', tone: 'text-amber-700' };
  if (c === 'success') return { verb: 'closed cleanly', tone: 'text-emerald-700' };
  if (c === 'failure') return { verb: 'failed', tone: 'text-rose-700' };
  if (c === 'cancelled') return { verb: 'was cancelled', tone: 'text-stone-500' };
  return { verb: 'ended', tone: 'text-stone-700' };
}

export function MissionControlV10Stream() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const projects = useProjects();

  const projectHueMap = useMemo(() => {
    const m = new Map<string, number>();
    (projects.data ?? []).forEach((p, i) =>
      m.set(p.id, PROJECT_HUES[i % PROJECT_HUES.length] ?? 200),
    );
    return m;
  }, [projects.data]);

  const data = runs.data ?? [];

  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const entries: Entry[] = useMemo(() => {
    const result: Entry[] = [];
    data.forEach((r) => {
      const hue = projectHueMap.get(r.projectId) ?? 200;
      if (r.startedAt) {
        result.push({
          ts: new Date(r.startedAt as string).getTime(),
          kind: 'started',
          run: r,
          hue,
        });
      }
      if (r.endedAt) {
        result.push({
          ts: new Date(r.endedAt as string).getTime(),
          kind: 'ended',
          run: r,
          hue,
        });
      } else if (r.pausedReason) {
        result.push({
          ts: r.startedAt ? new Date(r.startedAt as string).getTime() + 60_000 : Date.now(),
          kind: 'paused',
          run: r,
          hue,
        });
      }
    });
    return result.sort((a, b) => b.ts - a.ts);
  }, [data, projectHueMap]);

  const filtered = entries.filter((e) => {
    if (projectFilter && e.run.projectId !== projectFilter) return false;
    if (statusFilter) {
      const c = classify(e.run);
      if (statusFilter === 'live' && !(c === 'running' || c === 'paused')) return false;
      if (statusFilter === 'fail' && c !== 'failure') return false;
      if (statusFilter === 'ok' && c !== 'success') return false;
    }
    return true;
  });

  const byProject = useMemo(() => {
    const m = new Map<string, GlobalRunRow[]>();
    data.forEach((r) => {
      const arr = m.get(r.projectId) ?? [];
      arr.push(r);
      m.set(r.projectId, arr);
    });
    return m;
  }, [data]);

  return (
    <div
      data-mc-variant="stream"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-6 pt-4"
      style={{ background: '#fbf9f5', color: '#1c1917' }}
    >
      <style>{`
        [data-mc-variant="stream"] {
          font-family: ui-sans-serif, "Inter", "Helvetica Neue", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="stream"] .hair { border-color: rgba(28,25,23,0.12); }
        [data-mc-variant="stream"] .composer:focus-within {
          border-color: rgba(28,25,23,0.4);
          box-shadow: 0 0 0 3px rgba(28,25,23,0.06);
        }
      `}</style>

      <VariantSwitcher tone="paper" set="b" />

      {/* Top: filters + cross-project metrics inline */}
      <header className="flex flex-wrap items-end justify-between gap-4 border-b hair pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-600">
            stream · all activity · live
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Everything the agents are doing right now
          </h1>
          <div className="mt-1 max-w-prose text-[13px] text-stone-700">
            One chronological feed across {projects.data?.length ?? 0} projects. Each entry is an
            event: a run launched, paused, or closed. Reply to any entry to address the agent that
            did it (chat coming soon).
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-6 text-right">
          {[
            { k: 'Active', v: String(summary.data?.activeCount ?? 0) },
            { k: 'Runs · 7d', v: String(summary.data?.totalRuns ?? 0) },
            { k: 'Tokens · 7d', v: fmtTok(summary.data?.totalTokens ?? 0) },
            { k: 'Success', v: `${Math.round((summary.data?.successRate ?? 0) * 100)}%` },
          ].map((k) => (
            <div key={k.k} className="flex flex-col items-end leading-none">
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-stone-500">
                {k.k}
              </span>
              <span className="mt-1 text-base font-semibold tabular-nums text-stone-900">
                {k.v}
              </span>
            </div>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 pt-4 lg:grid-cols-[1fr_320px]">
        {/* FEED */}
        <main>
          {/* Filter chips */}
          <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]">
            <Chip
              active={projectFilter === null && statusFilter === null}
              onClick={() => {
                setProjectFilter(null);
                setStatusFilter(null);
              }}
            >
              all · {entries.length}
            </Chip>
            <span className="text-stone-400">·</span>
            <Chip
              active={statusFilter === 'live'}
              onClick={() => setStatusFilter(statusFilter === 'live' ? null : 'live')}
            >
              live
            </Chip>
            <Chip
              active={statusFilter === 'ok'}
              onClick={() => setStatusFilter(statusFilter === 'ok' ? null : 'ok')}
            >
              ok
            </Chip>
            <Chip
              active={statusFilter === 'fail'}
              onClick={() => setStatusFilter(statusFilter === 'fail' ? null : 'fail')}
            >
              fail
            </Chip>
            <span className="text-stone-400">·</span>
            {(projects.data ?? []).slice(0, 6).map((p) => {
              const hue = projectHueMap.get(p.id) ?? 200;
              return (
                <Chip
                  key={p.id}
                  active={projectFilter === p.id}
                  onClick={() => setProjectFilter(projectFilter === p.id ? null : p.id)}
                  hue={hue}
                >
                  {p.name}
                </Chip>
              );
            })}
          </div>

          {/* Stream entries */}
          {filtered.length === 0 ? (
            <div className="rounded-md border hair border-dashed bg-white px-4 py-10 text-center text-[13px] italic text-stone-600">
              Nothing matching this filter yet.
            </div>
          ) : (
            <ol className="flex flex-col">
              {filtered.slice(0, 60).map((e, idx) => {
                const { verb, tone } = entryLine(e);
                const c = classify(e.run);
                const liveBadge = c === 'running' || c === 'paused';
                const isFirst = idx === 0;
                return (
                  <li
                    key={`${e.run.id}-${e.kind}-${e.ts}`}
                    className={`group relative grid grid-cols-[24px_1fr_auto] gap-x-4 border-b hair py-3 transition-colors hover:bg-white/60 ${isFirst ? 'border-t' : ''}`}
                  >
                    {/* color rail */}
                    <span className="relative flex justify-center" aria-hidden>
                      <span
                        className="absolute top-0 bottom-0 w-px"
                        style={{ background: `hsl(${e.hue} 50% 60% / 0.45)` }}
                      />
                      <span
                        className="relative top-1 h-3 w-3 rounded-full"
                        style={{
                          background: `hsl(${e.hue} 60% 50%)`,
                          boxShadow: liveBadge ? `0 0 0 3px hsl(${e.hue} 60% 50% / 0.18)` : 'none',
                        }}
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <Link
                          to={`/projects/${e.run.projectId}`}
                          className="text-[14px] font-semibold tracking-tight hover:underline"
                          style={{ color: `hsl(${e.hue} 50% 30%)` }}
                        >
                          {e.run.projectName}
                        </Link>
                        <span className={`text-[14px] ${tone}`}>{verb}</span>
                        <Link
                          to={`/projects/${e.run.projectId}/run/${e.run.id}`}
                          className="font-mono text-[11px] text-stone-500 hover:text-stone-900"
                        >
                          {e.run.id.slice(0, 8)}
                        </Link>
                      </div>
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] text-stone-600">
                        <span>tok·in {fmtTok(e.run.tokensInTotal)}</span>
                        <span>tok·out {fmtTok(e.run.tokensOutTotal)}</span>
                        <span>turns {e.run.turnsTotal}</span>
                        {e.run.pausedReason && (
                          <span className="rounded-full bg-amber-100 px-1.5 py-px text-amber-800">
                            paused · {e.run.pausedReason}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 leading-none">
                      <span className="font-mono text-[11px] tabular-nums text-stone-600">
                        {rel(e.ts)} ago
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-stone-500">
                        {e.kind}
                      </span>
                      <button
                        className="rounded-full border hair px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-stone-500 opacity-0 transition-opacity hover:bg-white group-hover:opacity-100"
                        title="Reply to the agent on this run (coming soon)"
                        aria-label="Reply (coming soon)"
                        disabled
                      >
                        reply ↩
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </main>

        {/* SIDE — per-project digest + composer placeholder */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-9rem)] lg:overflow-auto">
          <div className="border hair bg-white px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
              by project · 7d
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {(projects.data ?? []).length === 0 ? (
                <li className="text-[12px] italic text-stone-600">No projects on file.</li>
              ) : (
                (projects.data ?? []).map((p) => {
                  const rs = byProject.get(p.id) ?? [];
                  const live = rs.filter(
                    (r) => classify(r) === 'running' || classify(r) === 'paused',
                  ).length;
                  const tok = rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0);
                  const hue = projectHueMap.get(p.id) ?? 200;
                  return (
                    <li
                      key={p.id}
                      className="flex items-center gap-2 border-l-[3px] py-1 pl-2 text-[12px]"
                      style={{ borderLeftColor: `hsl(${hue} 60% 50%)` }}
                    >
                      <span className="flex-1 truncate font-medium">{p.name}</span>
                      <span className="font-mono text-[10px] tabular-nums text-stone-500">
                        {rs.length} runs
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-stone-500">
                        {fmtTok(tok)}
                      </span>
                      {live > 0 && (
                        <span
                          className="rounded-full px-1.5 py-px font-mono text-[9px] tabular-nums"
                          style={{
                            background: `hsl(${hue} 60% 50% / 0.18)`,
                            color: `hsl(${hue} 50% 30%)`,
                          }}
                        >
                          {live}
                        </span>
                      )}
                    </li>
                  );
                })
              )}
            </ul>
          </div>

          <div className="composer border hair bg-white p-3 transition-shadow">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
                ask the team
              </span>
              <span className="rounded-full bg-amber-100 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-800">
                chat · soon
              </span>
            </div>
            <div className="cursor-not-allowed rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 font-mono text-[12px] text-stone-500">
              @architect why is run …7e8a stuck on the qa task?
            </div>
            <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.18em] text-stone-500">
              <span>cmd+k to address an agent</span>
              <span>v10 · stream</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  hue,
}: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  hue?: number;
}) {
  const bg = active ? (hue !== undefined ? `hsl(${hue} 60% 50%)` : '#1c1917') : 'transparent';
  const fg = active
    ? hue !== undefined
      ? '#fbf9f5'
      : '#fbf9f5'
    : hue !== undefined
      ? `hsl(${hue} 50% 30%)`
      : '#1c1917';
  const border = hue !== undefined ? `hsl(${hue} 60% 50% / 0.5)` : 'rgba(28,25,23,0.4)';
  return (
    <button
      onClick={onClick}
      className="rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
      style={{ background: bg, color: fg, borderColor: border }}
    >
      {children}
    </button>
  );
}
