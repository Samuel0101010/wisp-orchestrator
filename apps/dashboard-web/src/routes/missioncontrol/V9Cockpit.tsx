import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useGlobalRuns,
  useProjects,
  useProjectRuns,
  useRunsSummary,
  useTeam,
} from '@/api/queries';
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
  running: '#67e8f9',
  paused: '#fbbf24',
  success: '#86efac',
  failure: '#fb7185',
  cancelled: '#a1a1aa',
  pending: '#71717a',
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
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

function Spark({ data, w = 96, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length) return <span className="text-zinc-600">—</span>;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(' ');
  const lastY = h - ((data[data.length - 1] ?? 0) / max) * h;
  const lastX = (data.length - 1) * step;
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r={1.5} fill="currentColor" />
    </svg>
  );
}

export function MissionControlV9Cockpit() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);

  const projectMap = useMemo(() => {
    const m = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = m.get(r.projectId) ?? [];
      arr.push(r);
      m.set(r.projectId, arr);
    });
    return m;
  }, [globalRuns.data]);

  const projectList = useMemo(() => {
    const list = projects.data ?? [];
    return [...list].sort((a, b) => {
      const aActive = (projectMap.get(a.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      const bActive = (projectMap.get(b.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      if (aActive !== bActive) return bActive - aActive;
      return (projectMap.get(b.id)?.length ?? 0) - (projectMap.get(a.id)?.length ?? 0);
    });
  }, [projects.data, projectMap]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId == null && projectList.length > 0) {
      const firstActive = projectList.find((p) =>
        (projectMap.get(p.id) ?? []).some((r) => classify(r) === 'running' || classify(r) === 'paused'),
      );
      setSelectedId(firstActive?.id ?? projectList[0]?.id ?? null);
    }
  }, [selectedId, projectList, projectMap]);

  const selectedProject = projectList.find((p) => p.id === selectedId) ?? null;
  const selectedRuns = selectedId ? projectMap.get(selectedId) ?? [] : [];
  const team = useTeam(selectedId ?? undefined);
  const projectRuns = useProjectRuns(selectedId ?? undefined);

  const tokenSeries = useMemo(() => (summary.data?.tokensByDay ?? []).map((d) => d.tokens), [summary.data]);
  const runsSeries = useMemo(() => (summary.data?.runsByDay ?? []).map((d) => d.runs), [summary.data]);

  const kpis = [
    { k: 'Active', v: String(summary.data?.activeCount ?? 0) },
    { k: 'Runs · 7d', v: String(summary.data?.totalRuns ?? 0) },
    { k: 'Tokens · 7d', v: fmtTok(summary.data?.totalTokens ?? 0) },
    {
      k: 'Success',
      v: `${Math.round((summary.data?.successRate ?? 0) * 100)}%`,
    },
    { k: 'Projects', v: String(projectList.length) },
  ];

  const liveSelected = selectedRuns.filter((r) => classify(r) === 'running' || classify(r) === 'paused');
  const recentSelected = selectedRuns.slice(0, 8);

  return (
    <div
      data-mc-variant="cockpit"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_1fr] [color-scheme:dark]"
      style={{ background: '#08090b', color: '#e4e4e7' }}
    >
      <style>{`
        [data-mc-variant="cockpit"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="cockpit"] .hairline { border-color: rgba(255,255,255,0.07); }
        [data-mc-variant="cockpit"] .hairline-strong { border-color: rgba(255,255,255,0.14); }
        [data-mc-variant="cockpit"] .pulse-dot::after {
          content: ''; position: absolute; inset: -3px; border-radius: 9999px;
          border: 1px solid currentColor; opacity: 0.5;
          animation: cockpit-pulse 1.8s ease-out infinite;
        }
        @keyframes cockpit-pulse {
          0% { transform: scale(0.8); opacity: 0.6; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="cockpit"] .pulse-dot::after { animation: none; }
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="b" />
      </div>

      {/* TOP STRIP — Aggregate */}
      <header className="flex items-center justify-between gap-6 border-b hairline px-6 pb-3 pt-1">
        <div className="flex items-baseline gap-3">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.3em]"
            style={{ color: '#67e8f9' }}
          >
            cockpit
          </div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Mission Control</h1>
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
            cross-project · 7d window
          </span>
        </div>
        <div className="flex items-center gap-7 text-right">
          {kpis.map((k) => (
            <div key={k.k} className="flex flex-col leading-none">
              <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">{k.k}</span>
              <span className="mt-1 text-base font-semibold tabular-nums text-zinc-100">{k.v}</span>
            </div>
          ))}
          <div className="flex flex-col items-end leading-none text-cyan-300">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">tok·d</span>
            <Spark data={tokenSeries} w={64} h={18} />
          </div>
          <div className="flex flex-col items-end leading-none text-emerald-300">
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">runs·d</span>
            <Spark data={runsSeries} w={64} h={18} />
          </div>
        </div>
      </header>

      {/* 3-PANE BODY */}
      <div className="grid min-h-0 grid-cols-[280px_minmax(0,1fr)_360px]">
        {/* LEFT RAIL — projects */}
        <aside className="flex min-h-0 flex-col border-r hairline">
          <div className="flex items-baseline justify-between border-b hairline px-4 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
              projects
            </span>
            <span className="font-mono text-[10px] tabular-nums text-zinc-600">
              {projectList.length}
            </span>
          </div>
          <ul className="flex-1 overflow-auto">
            {projectList.length === 0 && (
              <li className="px-4 py-6 text-[12px] italic text-zinc-600">
                No projects on file.
              </li>
            )}
            {projectList.map((p) => {
              const rs = projectMap.get(p.id) ?? [];
              const live = rs.filter(
                (r) => classify(r) === 'running' || classify(r) === 'paused',
              ).length;
              const sparkData = (() => {
                const buckets = Array.from({ length: 7 }, () => 0);
                rs.forEach((r) => {
                  if (!r.startedAt) return;
                  const days = Math.floor((Date.now() - new Date(r.startedAt as string).getTime()) / 86_400_000);
                  if (days >= 0 && days < 7) buckets[6 - days] = (buckets[6 - days] ?? 0) + 1;
                });
                return buckets;
              })();
              const isSel = selectedId === p.id;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => setSelectedId(p.id)}
                    className={`group flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left transition-colors ${
                      isSel
                        ? 'border-l-cyan-400 bg-cyan-400/5'
                        : 'border-l-transparent hover:bg-white/3'
                    }`}
                  >
                    <span className="relative flex h-2 w-2 flex-none items-center justify-center">
                      <span
                        className={`block h-2 w-2 rounded-full ${live > 0 ? 'pulse-dot' : ''}`}
                        style={{
                          background: live > 0 ? TONE.running : '#3f3f46',
                          color: TONE.running,
                        }}
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium text-zinc-100">{p.name}</span>
                      <span className="truncate font-mono text-[10px] text-zinc-500">
                        {rs.length} runs · {fmtTok(rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0))}
                      </span>
                    </span>
                    <span className={`flex flex-col items-end gap-1 ${isSel ? 'text-cyan-300' : 'text-zinc-500'}`}>
                      {live > 0 && (
                        <span className="rounded-full bg-cyan-400/15 px-1.5 py-px font-mono text-[9px] font-medium tabular-nums text-cyan-300">
                          {live} live
                        </span>
                      )}
                      <Spark data={sparkData} w={48} h={14} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-600">
            ↑↓ navigate · enter open
          </div>
        </aside>

        {/* CENTER — selected project */}
        <main className="flex min-h-0 flex-col overflow-auto">
          {selectedProject ? (
            <div className="flex flex-col">
              <header className="border-b hairline px-6 py-4">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">
                    {selectedProject.name}
                  </h2>
                  <Link
                    to={`/projects/${selectedProject.id}`}
                    className="font-mono text-[11px] tracking-tight text-zinc-500 hover:text-zinc-200"
                  >
                    open ↗
                  </Link>
                </div>
                <div className="mt-1 max-w-prose text-[13px] text-zinc-400">{selectedProject.goal}</div>
                <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  <span>repo · {selectedProject.repoPath}</span>
                  <span>runs · {selectedRuns.length}</span>
                  <span style={{ color: liveSelected.length > 0 ? TONE.running : undefined }}>
                    live · {liveSelected.length}
                  </span>
                </div>
              </header>

              {/* In-flight section */}
              <section className="px-6 pt-5">
                <div className="mb-3 flex items-baseline justify-between">
                  <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
                    in flight · this project
                  </h3>
                  <span className="font-mono text-[10px] tabular-nums text-zinc-600">
                    {liveSelected.length} active
                  </span>
                </div>
                {liveSelected.length === 0 ? (
                  <div className="rounded-md border hairline-strong bg-white/3 px-4 py-6 text-center text-[13px] text-zinc-500">
                    Nothing running for this project right now.
                  </div>
                ) : (
                  <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    {liveSelected.map((r) => (
                      <li
                        key={r.id}
                        className="group relative overflow-hidden rounded-md border hairline-strong bg-white/3 p-3"
                      >
                        <div className="flex items-baseline justify-between">
                          <Link
                            to={`/projects/${r.projectId}/run/${r.id}`}
                            className="font-mono text-[11px] tracking-tight text-cyan-300 hover:underline"
                          >
                            {r.id.slice(0, 8)}
                          </Link>
                          <span
                            className="rounded-full px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em]"
                            style={{ color: TONE[classify(r)], background: `${TONE[classify(r)]}1a` }}
                          >
                            {classify(r)}
                          </span>
                        </div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                          <Field k="tok·in" v={fmtTok(r.tokensInTotal)} />
                          <Field k="tok·out" v={fmtTok(r.tokensOutTotal)} />
                          <Field k="turns" v={String(r.turnsTotal)} />
                        </div>
                        <div className="mt-2 flex items-baseline justify-between font-mono text-[10px] text-zinc-500">
                          <span>started {rel(r.startedAt)}</span>
                          <span>budget {r.budgetMinutes}m</span>
                        </div>
                        <div
                          className="absolute inset-x-0 bottom-0 h-px"
                          style={{ background: `linear-gradient(90deg, transparent, ${TONE[classify(r)]}, transparent)` }}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Recent runs (this project) */}
              <section className="px-6 pb-6 pt-6">
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
                    history · recent runs
                  </h3>
                  <span className="font-mono text-[10px] tabular-nums text-zinc-600">
                    last {Math.min(recentSelected.length, 8)} of {selectedRuns.length}
                  </span>
                </div>
                <div className="overflow-hidden rounded-md border hairline-strong">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-white/3 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                        <th className="border-b hairline px-3 py-1.5 text-left font-normal">state</th>
                        <th className="border-b hairline px-3 py-1.5 text-left font-normal">id</th>
                        <th className="border-b hairline px-3 py-1.5 text-right font-normal">tok</th>
                        <th className="border-b hairline px-3 py-1.5 text-right font-normal">turns</th>
                        <th className="border-b hairline px-3 py-1.5 text-right font-normal">started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentSelected.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-3 py-4 italic text-zinc-500">
                            No runs yet.
                          </td>
                        </tr>
                      ) : (
                        recentSelected.map((r) => {
                          const c = classify(r);
                          return (
                            <tr key={r.id} className="border-t hairline hover:bg-white/3">
                              <td className="px-3 py-1.5">
                                <span
                                  className="font-mono text-[11px] uppercase tracking-[0.18em]"
                                  style={{ color: TONE[c] }}
                                >
                                  {c}
                                </span>
                              </td>
                              <td className="px-3 py-1.5">
                                <Link
                                  to={`/projects/${r.projectId}/run/${r.id}`}
                                  className="font-mono text-[11px] text-zinc-200 hover:text-cyan-300"
                                >
                                  {r.id.slice(0, 10)}
                                </Link>
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-300">
                                {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-400">
                                {r.turnsTotal}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-[11px] text-zinc-500">
                                {rel(r.startedAt)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2 text-right font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  Stream · {projectRuns.data?.length ?? selectedRuns.length} total runs ·{' '}
                  <Link to={`/projects/${selectedProject.id}`} className="text-zinc-300 hover:text-cyan-300">
                    full project ↗
                  </Link>
                </div>
              </section>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-zinc-500">
              Select a project from the left rail.
            </div>
          )}
        </main>

        {/* RIGHT RAIL — Agent chat dock (placeholder slot) */}
        <aside className="flex min-h-0 flex-col border-l hairline">
          <div className="flex items-baseline justify-between border-b hairline px-4 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
              agents
            </span>
            <span className="rounded-full bg-amber-400/15 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300">
              chat · soon
            </span>
          </div>
          <div className="flex-1 overflow-auto px-4 py-4">
            {team.data?.roles && team.data.roles.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {team.data.roles.map((role) => {
                  const tone =
                    role.role.toLowerCase().includes('architect')
                      ? '#67e8f9'
                      : role.role.toLowerCase().includes('qa') || role.role.toLowerCase().includes('review')
                        ? '#fbbf24'
                        : '#86efac';
                  return (
                    <li
                      key={role.role}
                      className="flex flex-col gap-2 rounded-md border hairline-strong bg-white/3 p-3"
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold uppercase"
                          style={{
                            background: `${tone}1a`,
                            color: tone,
                            border: `1px solid ${tone}40`,
                          }}
                        >
                          {role.role.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                          <span className="text-[13px] font-medium text-zinc-100">{role.role}</span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                            {role.model}
                          </span>
                        </div>
                      </div>
                      <p className="line-clamp-2 text-[11px] text-zinc-400">{role.systemPrompt.slice(0, 140)}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex flex-col items-stretch gap-2 rounded-md border border-dashed border-white/10 p-4 text-center">
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  No team for this project yet
                </span>
                {selectedProject && (
                  <Link
                    to={`/projects/${selectedProject.id}/teams`}
                    className="text-[12px] text-cyan-300 hover:underline"
                  >
                    Configure team →
                  </Link>
                )}
              </div>
            )}
          </div>
          <div className="border-t hairline p-3">
            <div className="rounded-md border hairline-strong bg-white/3 p-3 opacity-70">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  ask an agent
                </span>
                <span className="font-mono text-[9px] tracking-[0.18em] text-amber-300/80">
                  placeholder
                </span>
              </div>
              <div className="flex h-16 cursor-not-allowed items-start rounded-md border border-dashed border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-zinc-500">
                @architect, what's the next step on…
              </div>
              <div className="mt-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-600">
                <span>cmd+enter to send · soon</span>
                <span>v9 · cockpit</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col leading-none">
      <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">{k}</span>
      <span className="mt-1 font-mono tabular-nums text-zinc-100">{v}</span>
    </div>
  );
}
