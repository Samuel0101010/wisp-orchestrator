import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useGeneratedPlan,
  useGlobalRuns,
  useProjects,
  useProjectRuns,
  useRunsSummary,
  useTeam,
} from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import type { Plan } from '@agent-harness/schemas';
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

interface DagNode {
  id: string;
  role?: string;
  prompt?: string;
  dependsOn?: string[];
  layer: number;
  laneIndex: number;
}

function layoutPlan(plan: Plan | null): DagNode[] {
  if (!plan || !Array.isArray(plan.nodes)) return [];
  const tasks = plan.nodes;
  const layerOf = new Map<string, number>();
  const remaining = new Set<string>(tasks.map((t) => t.id));
  let layer = 0;
  while (remaining.size > 0 && layer < 32) {
    const ready: string[] = [];
    for (const id of remaining) {
      const task = tasks.find((t) => t.id === id);
      if (!task) continue;
      const deps = task.deps ?? [];
      if (deps.every((d) => layerOf.has(d) || !remaining.has(d))) {
        ready.push(id);
      }
    }
    if (ready.length === 0) {
      for (const id of remaining) ready.push(id);
    }
    ready.forEach((id) => {
      layerOf.set(id, layer);
      remaining.delete(id);
    });
    layer += 1;
  }
  const byLayer = new Map<number, string[]>();
  layerOf.forEach((l, id) => {
    const arr = byLayer.get(l) ?? [];
    arr.push(id);
    byLayer.set(l, arr);
  });
  const nodes: DagNode[] = [];
  tasks.forEach((t) => {
    const l = layerOf.get(t.id) ?? 0;
    const lane = byLayer.get(l) ?? [];
    nodes.push({
      id: t.id,
      role: t.role,
      prompt: t.prompt,
      dependsOn: t.deps ?? [],
      layer: l,
      laneIndex: lane.indexOf(t.id),
    });
  });
  return nodes;
}

const ROLE_TONE: Record<string, string> = {
  architect: '#67e8f9',
  developer: '#86efac',
  qa: '#fbbf24',
  reviewer: '#c084fc',
};

export function MissionControlV16Focus() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);

  const projectRuns = useMemo(() => {
    const m = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = m.get(r.projectId) ?? [];
      arr.push(r);
      m.set(r.projectId, arr);
    });
    return m;
  }, [globalRuns.data]);

  const sortedProjects = useMemo(() => {
    return [...(projects.data ?? [])].sort((a, b) => {
      const al = (projectRuns.get(a.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      const bl = (projectRuns.get(b.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      return bl - al;
    });
  }, [projects.data, projectRuns]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId == null && sortedProjects.length > 0) {
      setSelectedId(sortedProjects[0]?.id ?? null);
    }
  }, [selectedId, sortedProjects]);

  const selected = sortedProjects.find((p) => p.id === selectedId) ?? null;
  const team = useTeam(selectedId ?? undefined);
  const plan = useGeneratedPlan(selectedId ?? undefined);
  const allRuns = useProjectRuns(selectedId ?? undefined);
  const runsForProject = projectRuns.get(selectedId ?? '') ?? [];
  const liveRun =
    runsForProject.find((r) => classify(r) === 'running' || classify(r) === 'paused') ?? null;

  const dag = useMemo(() => layoutPlan(plan.data?.dagJson ?? plan.data?.plan ?? null), [plan.data]);
  const layers = useMemo(() => {
    const m = new Map<number, DagNode[]>();
    dag.forEach((n) => {
      const arr = m.get(n.layer) ?? [];
      arr.push(n);
      m.set(n.layer, arr);
    });
    return Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  }, [dag]);

  // killer feature: active task highlight (mock — pick a node based on live run progress)
  const activeNodeIdx = liveRun
    ? Math.min(dag.length - 1, Math.floor(((liveRun.turnsTotal % 12) / 12) * dag.length))
    : -1;
  const activeNodeId = dag[activeNodeIdx]?.id ?? null;
  const completedNodeIds = useMemo(() => {
    if (!liveRun || dag.length === 0) return new Set<string>();
    const completedCount = Math.max(0, activeNodeIdx);
    return new Set(dag.slice(0, completedCount).map((n) => n.id));
  }, [liveRun, dag, activeNodeIdx]);

  const [chatOpen, setChatOpen] = useState(true);
  const [taskChatId, setTaskChatId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');

  return (
    <div
      data-mc-variant="focus"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_auto_1fr] [color-scheme:dark]"
      style={{ background: '#0a0b0f', color: '#e4e4e7' }}
    >
      <style>{`
        [data-mc-variant="focus"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="focus"] .tab[data-active="true"] {
          background: rgba(255,255,255,0.06);
          color: #fafafa;
          border-color: rgba(255,255,255,0.15);
        }
        [data-mc-variant="focus"] .node {
          transition: transform 200ms cubic-bezier(0.32,0.72,0,1), box-shadow 200ms;
          cursor: pointer;
        }
        [data-mc-variant="focus"] .node:hover { transform: translateY(-1px); }
        @keyframes focus-pulse {
          0%, 100% { box-shadow: 0 0 0 0 currentColor; }
          50% { box-shadow: 0 0 0 6px transparent; }
        }
        [data-mc-variant="focus"] .node-active { animation: focus-pulse 1.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="focus"] .node-active { animation: none; }
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="c" />
      </div>

      {/* Project tabs (Cursor-style) */}
      <header className="flex items-center justify-between gap-4 border-b border-white/5 px-6 pb-2">
        <div className="flex items-center gap-1 overflow-x-auto">
          {sortedProjects.length === 0 ? (
            <div className="font-mono text-[12px] text-zinc-500">no projects on file</div>
          ) : (
            sortedProjects.map((p) => {
              const rs = projectRuns.get(p.id) ?? [];
              const live = rs.filter(
                (r) => classify(r) === 'running' || classify(r) === 'paused',
              ).length;
              const isSel = selectedId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  data-active={isSel}
                  className="tab flex items-center gap-2 rounded-md border border-transparent px-3 py-1.5 font-mono text-[12px] tracking-tight text-zinc-400 hover:text-zinc-100"
                >
                  {live > 0 && <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400" />}
                  <span>{p.name}</span>
                  {live > 0 && (
                    <span className="rounded-full bg-emerald-400/15 px-1.5 py-px text-[9px] tabular-nums text-emerald-300">
                      {live}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          <span>
            cross-project · {summary.data?.activeCount ?? 0} live ·{' '}
            {fmtTok(summary.data?.totalTokens ?? 0)}/7d
          </span>
          <button
            onClick={() => setChatOpen(!chatOpen)}
            className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] hover:bg-white/5"
          >
            {chatOpen ? '— hide chat' : '+ show chat'}
          </button>
        </div>
      </header>

      {/* MAIN — selected project focus */}
      <div
        className={`grid min-h-0 ${chatOpen ? 'grid-cols-[minmax(0,1fr)_360px]' : 'grid-cols-[minmax(0,1fr)]'} gap-px bg-white/5`}
      >
        <main className="min-h-0 overflow-auto bg-[#0a0b0f]">
          {!selected ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-zinc-500">
              select a project tab to focus
            </div>
          ) : (
            <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
              {/* Project hero strip */}
              <section className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
                    {selected.name}
                  </h1>
                  <p className="mt-1 max-w-prose text-[13px] text-zinc-400">{selected.goal}</p>
                </div>
                <div className="flex items-end gap-5 font-mono text-[11px] tabular-nums">
                  {[
                    { k: 'runs', v: String(allRuns.data?.length ?? runsForProject.length) },
                    {
                      k: 'live',
                      v: String(
                        runsForProject.filter(
                          (r) => classify(r) === 'running' || classify(r) === 'paused',
                        ).length,
                      ),
                      tone: '#34d399',
                    },
                    {
                      k: 'tok·all',
                      v: fmtTok(
                        runsForProject.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0),
                      ),
                    },
                    { k: 'team', v: String(team.data?.roles?.length ?? 0) },
                  ].map((s) => (
                    <div key={s.k} className="flex flex-col items-end leading-none">
                      <span className="text-[9px] uppercase tracking-[0.25em] text-zinc-500">
                        {s.k}
                      </span>
                      <span className="mt-1 text-[15px] text-zinc-100" style={{ color: s.tone }}>
                        {s.v}
                      </span>
                    </div>
                  ))}
                  <Link
                    to={`/projects/${selected.id}`}
                    className="rounded-full border border-white/15 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] text-zinc-100 hover:bg-white/10"
                  >
                    open ↗
                  </Link>
                </div>
              </section>

              {/* PLAN-DAG — primary surface */}
              <section className="rounded-lg border border-white/10 bg-white/3 p-4">
                <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-400">
                      plan · {dag.length} tasks · {layers.length} layers
                    </span>
                    {liveRun && (
                      <span className="ml-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-300">
                        <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400" /> live ·{' '}
                        {liveRun.id.slice(0, 6)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    <span className="flex items-center gap-1.5">
                      <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400" /> done
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="block h-1.5 w-1.5 rounded-full bg-cyan-400" /> active
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="block h-1.5 w-1.5 rounded-full bg-zinc-500" /> queued
                    </span>
                  </div>
                </header>
                {dag.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-12 text-center">
                    <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                      no plan yet
                    </div>
                    <Link
                      to={`/projects/${selected.id}/plan`}
                      className="rounded-full bg-cyan-500 px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-950 hover:bg-cyan-400"
                    >
                      generate plan →
                    </Link>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <div
                      className="flex items-stretch gap-8 py-2"
                      style={{ minWidth: layers.length * 220 }}
                    >
                      {layers.map(([l, nodes]) => (
                        <div key={l} className="flex flex-col gap-3" style={{ minWidth: 200 }}>
                          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                            layer {l + 1}
                          </div>
                          {nodes.map((n) => {
                            const tone = n.role
                              ? (ROLE_TONE[
                                  n.role.toLowerCase().split(/[-_\s]/)[0] ?? 'developer'
                                ] ?? '#86efac')
                              : '#86efac';
                            const isActive = n.id === activeNodeId;
                            const isDone = completedNodeIds.has(n.id);
                            return (
                              <div
                                key={n.id}
                                className={`node group relative rounded-lg border p-3 ${isActive ? 'node-active' : ''}`}
                                style={{
                                  background: isActive
                                    ? 'rgba(103,232,249,0.07)'
                                    : isDone
                                      ? 'rgba(134,239,172,0.05)'
                                      : 'rgba(255,255,255,0.02)',
                                  borderColor: isActive
                                    ? 'rgba(103,232,249,0.5)'
                                    : isDone
                                      ? 'rgba(134,239,172,0.3)'
                                      : 'rgba(255,255,255,0.1)',
                                  color: isActive ? '#67e8f9' : 'transparent',
                                }}
                                onClick={() => setTaskChatId(n.id)}
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className="rounded-full px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em]"
                                    style={{ background: `${tone}1f`, color: tone }}
                                  >
                                    {n.role ?? 'task'}
                                  </span>
                                  <span className="font-mono text-[10px] text-zinc-500">
                                    {n.id.slice(0, 8)}
                                  </span>
                                  {isDone && <span className="ml-auto text-emerald-400">✓</span>}
                                  {isActive && (
                                    <span className="ml-auto block h-1.5 w-1.5 rounded-full bg-cyan-400 pulse" />
                                  )}
                                </div>
                                <p className="mt-2 line-clamp-2 text-[12px] text-zinc-200">
                                  {n.prompt?.slice(0, 100) ?? '—'}
                                </p>
                                <button className="mt-2 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-200">
                                  ↳ ask {n.role ?? 'agent'}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* live tail / runs strip */}
              <section className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
                <div className="rounded-lg border border-white/10 bg-white/3 p-4">
                  <header className="mb-2 flex items-baseline justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
                      runs · this project
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-zinc-600">
                      {runsForProject.length} total
                    </span>
                  </header>
                  {runsForProject.length === 0 ? (
                    <div className="py-6 text-center text-[12px] italic text-zinc-500">
                      no runs yet — lock the plan and run.
                    </div>
                  ) : (
                    <ul className="flex flex-col">
                      {runsForProject.slice(0, 6).map((r) => {
                        const c = classify(r);
                        const tone =
                          c === 'failure'
                            ? '#fb7185'
                            : c === 'running' || c === 'paused'
                              ? '#67e8f9'
                              : c === 'success'
                                ? '#86efac'
                                : '#71717a';
                        return (
                          <li
                            key={r.id}
                            className="grid grid-cols-[1fr_60px_72px_60px_60px_auto] items-baseline gap-3 border-b border-white/5 py-1.5 last:border-b-0"
                          >
                            <Link
                              to={`/projects/${r.projectId}/run/${r.id}`}
                              className="flex items-center gap-2 truncate font-mono text-[12px] text-zinc-100 hover:underline"
                            >
                              <span
                                className="block h-1.5 w-1.5 flex-none rounded-full"
                                style={{ background: tone }}
                              />
                              {r.id.slice(0, 10)}
                            </Link>
                            <span
                              className="text-right font-mono text-[10px] uppercase tracking-[0.18em]"
                              style={{ color: tone }}
                            >
                              {c}
                            </span>
                            <span className="text-right font-mono tabular-nums text-zinc-300">
                              {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                            </span>
                            <span className="text-right font-mono tabular-nums text-zinc-500">
                              {r.turnsTotal}t
                            </span>
                            <span className="text-right font-mono text-[10px] text-zinc-500">
                              {rel(r.startedAt)}
                            </span>
                            <span className="font-mono text-[10px] text-zinc-500">
                              {r.budgetMinutes}m
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-white/10 bg-white/3 p-4">
                  <header className="mb-2 font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
                    team · agents
                  </header>
                  {team.data?.roles && team.data.roles.length > 0 ? (
                    <ul className="flex flex-col gap-2">
                      {team.data.roles.map((role) => {
                        const key = role.role.toLowerCase().split(/[-_\s]/)[0] ?? 'developer';
                        const tone = ROLE_TONE[key] ?? '#86efac';
                        return (
                          <li key={role.role} className="flex items-center gap-2.5">
                            <span
                              className="grid h-7 w-7 flex-none place-items-center rounded-full text-[10px] font-bold uppercase"
                              style={{
                                background: `${tone}1f`,
                                color: tone,
                                border: `1px solid ${tone}40`,
                              }}
                            >
                              {role.role.slice(0, 2)}
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col leading-tight">
                              <span className="truncate text-[12px] font-medium text-zinc-100">
                                @{role.role}
                              </span>
                              <span className="font-mono text-[10px] text-zinc-500">
                                {role.model}
                              </span>
                            </div>
                            <button className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-400 hover:text-zinc-100 hover:bg-white/5">
                              ask
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="text-[12px] italic text-zinc-500">
                      <Link
                        to={`/projects/${selected.id}/teams`}
                        className="text-cyan-300 hover:underline"
                      >
                        configure team →
                      </Link>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </main>

        {chatOpen && (
          <aside className="flex min-h-0 flex-col bg-[#0a0b0f]">
            <header className="border-b border-white/5 px-4 py-3">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
                  {taskChatId ? `task ${taskChatId.slice(0, 8)}` : 'project chat'}
                </span>
                {taskChatId && (
                  <button
                    onClick={() => setTaskChatId(null)}
                    className="font-mono text-[10px] text-zinc-500 hover:text-zinc-200"
                  >
                    ← project
                  </button>
                )}
              </div>
              <div className="mt-1 text-[12px] text-zinc-200">{selected?.name ?? '—'}</div>
            </header>

            <div className="flex-1 overflow-auto px-4 py-3">
              {team.data?.roles && team.data.roles.length > 0 ? (
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                    available agents
                  </div>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {team.data.roles.map((role) => {
                      const key = role.role.toLowerCase().split(/[-_\s]/)[0] ?? 'developer';
                      const tone = ROLE_TONE[key] ?? '#86efac';
                      return (
                        <li
                          key={role.role}
                          className="flex items-center gap-2 rounded-md bg-white/3 p-2 hover:bg-white/5"
                        >
                          <span
                            className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-bold uppercase"
                            style={{ background: `${tone}1f`, color: tone }}
                          >
                            {role.role.slice(0, 2)}
                          </span>
                          <span className="flex-1 text-[12px] text-zinc-200">@{role.role}</span>
                          <span className="font-mono text-[10px] text-zinc-500">{role.model}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <div className="text-[12px] italic text-zinc-500">No team yet.</div>
              )}
            </div>

            <div className="border-t border-white/5 p-3">
              <div className="rounded-lg border border-white/10 bg-white/3 p-2.5 focus-within:border-cyan-400/40">
                <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  {taskChatId ? `re: task ${taskChatId.slice(0, 8)}` : 'message project'}
                </div>
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  rows={3}
                  placeholder={taskChatId ? 'why is this task stuck?' : 'ask anything…'}
                  className="w-full resize-none border-0 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
                />
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  <span>cmd+enter</span>
                  <span className="rounded-full bg-amber-400/15 px-1.5 py-px text-amber-300">
                    soon
                  </span>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
