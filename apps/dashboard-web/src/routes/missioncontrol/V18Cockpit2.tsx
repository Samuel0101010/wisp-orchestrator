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

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtUsd(n: number) {
  if (n < 0.01) return '<$0.01';
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
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

function elapsedSec(r: GlobalRunRow): number {
  if (!r.startedAt) return 0;
  const start = new Date(r.startedAt as string).getTime();
  const end = r.endedAt ? new Date(r.endedAt as string).getTime() : Date.now();
  return Math.max(1, (end - start) / 1000);
}

// Mock token cost per 1M tokens (Sonnet-ish averages, just for illustrative projection)
const COST_PER_M_IN = 3;
const COST_PER_M_OUT = 15;
function projectedCost(r: GlobalRunRow): number {
  return (r.tokensInTotal / 1_000_000) * COST_PER_M_IN + (r.tokensOutTotal / 1_000_000) * COST_PER_M_OUT;
}

function burnRateEta(r: GlobalRunRow): { tokPerMin: number; etaMs: number; etaText: string } {
  const elapsed = elapsedSec(r);
  const total = r.tokensInTotal + r.tokensOutTotal;
  const tokPerMin = elapsed > 0 ? (total * 60) / elapsed : 0;
  const elapsedMin = elapsed / 60;
  const remainingMin = Math.max(0, r.budgetMinutes - elapsedMin);
  const etaMs = remainingMin * 60_000;
  let etaText = '—';
  if (remainingMin <= 0) etaText = 'budget exceeded';
  else if (remainingMin < 1) etaText = '<1m to budget';
  else if (remainingMin < 60) etaText = `${Math.round(remainingMin)}m to budget`;
  else etaText = `${(remainingMin / 60).toFixed(1)}h to budget`;
  return { tokPerMin, etaMs, etaText };
}

const ROLE_TONE: Record<string, string> = {
  architect: '#67e8f9',
  developer: '#86efac',
  qa: '#fbbf24',
  reviewer: '#c084fc',
};

export function MissionControlV18Cockpit2() {
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

  const sortedProjects = useMemo(() => {
    return [...(projects.data ?? [])].sort((a, b) => {
      const al = (projectMap.get(a.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      const bl = (projectMap.get(b.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      return bl - al;
    });
  }, [projects.data, projectMap]);

  const [mode, setMode] = useState<'project' | 'aggregate'>('project');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId == null && sortedProjects.length > 0) {
      setSelectedId(sortedProjects[0]?.id ?? null);
    }
  }, [selectedId, sortedProjects]);

  const selected = sortedProjects.find((p) => p.id === selectedId) ?? null;
  const team = useTeam(selectedId ?? undefined);
  const projectRunRows = useProjectRuns(selectedId ?? undefined);
  const selectedRuns = selectedId ? projectMap.get(selectedId) ?? [] : [];
  const liveRun = selectedRuns.find((r) => classify(r) === 'running' || classify(r) === 'paused') ?? null;

  // Cross-project live runs (for aggregate mode)
  const allLive = (globalRuns.data ?? []).filter(
    (r) => classify(r) === 'running' || classify(r) === 'paused',
  );

  // tick for live calculations
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const [composer, setComposer] = useState('');
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  return (
    <div
      data-mc-variant="cockpit2"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] [color-scheme:dark]"
      style={{ background: '#08090b', color: '#e4e4e7' }}
    >
      <style>{`
        [data-mc-variant="cockpit2"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="cockpit2"] .pulse {
          animation: c2-pulse 2s ease-in-out infinite;
        }
        @keyframes c2-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="cockpit2"] .pulse { animation: none; }
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="c" />
      </div>

      {/* TOP — KPIs and mode switch */}
      <header className="grid grid-cols-[auto_1fr_auto] items-end gap-6 border-b border-white/5 px-6 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
            cockpit² · operations
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">Mission Control</h1>
            <div className="flex rounded-full border border-white/10 p-0.5">
              <button
                onClick={() => setMode('project')}
                className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${mode === 'project' ? 'bg-cyan-500 text-zinc-950' : 'text-zinc-400'}`}
              >
                project
              </button>
              <button
                onClick={() => setMode('aggregate')}
                className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${mode === 'aggregate' ? 'bg-cyan-500 text-zinc-950' : 'text-zinc-400'}`}
              >
                aggregate
              </button>
            </div>
          </div>
        </div>
        <div />
        <div className="flex items-end gap-6 font-mono text-[11px] tabular-nums">
          {[
            { k: 'live', v: summary.data?.activeCount ?? 0, tone: '#22d3ee' },
            { k: 'runs/7d', v: summary.data?.totalRuns ?? 0 },
            { k: 'tok/7d', v: fmtTok(summary.data?.totalTokens ?? 0) },
            { k: 'ok', v: `${Math.round((summary.data?.successRate ?? 0) * 100)}%` },
            { k: 'projects', v: projects.data?.length ?? 0 },
          ].map((s) => (
            <div key={s.k} className="flex flex-col items-end leading-none">
              <span className="text-[9px] uppercase tracking-[0.25em] text-zinc-500">{s.k}</span>
              <span className="mt-1 text-[15px]" style={{ color: s.tone }}>
                {s.v}
              </span>
            </div>
          ))}
        </div>
      </header>

      {/* 3-pane body */}
      <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)_360px] gap-px bg-white/5">
        {/* LEFT — projects rail */}
        <aside className="flex min-h-0 flex-col overflow-auto bg-[#08090b]">
          <div className="flex items-baseline justify-between border-b border-white/5 px-4 py-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">projects</span>
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">{sortedProjects.length}</span>
          </div>
          <ul className="flex-1">
            {sortedProjects.map((p) => {
              const rs = projectMap.get(p.id) ?? [];
              const live = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length;
              const tok = rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0);
              const isSel = selectedId === p.id;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setSelectedId(p.id);
                      setMode('project');
                    }}
                    className={`flex w-full items-center gap-2.5 border-l-2 px-4 py-2.5 text-left ${isSel && mode === 'project' ? 'border-l-cyan-400 bg-cyan-400/5' : 'border-l-transparent hover:bg-white/3'}`}
                  >
                    <span
                      className={`block h-2 w-2 flex-none rounded-full ${live > 0 ? 'pulse' : ''}`}
                      style={{ background: live > 0 ? '#22d3ee' : '#3f3f46' }}
                    />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-[13px] font-medium text-zinc-100">{p.name}</span>
                      <span className="font-mono text-[10px] text-zinc-500">
                        {rs.length} runs · {fmtTok(tok)}
                      </span>
                    </span>
                    {live > 0 && (
                      <span className="rounded-full bg-cyan-400/15 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-cyan-300">
                        {live}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-white/5 p-3 font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-500">
            ⌘ + click · pin · ⌘+n · new project
          </div>
        </aside>

        {/* CENTER */}
        <main className="min-h-0 overflow-auto bg-[#0b0c10]">
          {mode === 'aggregate' ? (
            <div className="flex flex-col gap-4 px-6 pb-6 pt-5">
              <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">All projects · in flight</h2>
              {allLive.length === 0 ? (
                <div className="rounded-lg border border-white/10 bg-white/3 p-12 text-center font-mono text-[12px] text-zinc-500">
                  Nothing live across {sortedProjects.length} projects.
                </div>
              ) : (
                <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {allLive.map((r) => (
                    <li key={r.id}>
                      <LiveCard run={r} />
                    </li>
                  ))}
                </ul>
              )}

              <h2 className="mt-4 text-base font-semibold tracking-tight text-zinc-200">Recent across projects</h2>
              <ul className="overflow-hidden rounded-lg border border-white/10">
                {(globalRuns.data ?? []).slice(0, 12).map((r) => (
                  <li key={r.id} className="border-b border-white/5 px-3 py-2 hover:bg-white/3 last:border-b-0">
                    <Link
                      to={`/projects/${r.projectId}/run/${r.id}`}
                      className="grid grid-cols-[1fr_72px_72px_60px_56px] items-baseline gap-3 text-[12px]"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="block h-1.5 w-1.5 flex-none rounded-full" style={{ background: classify(r) === 'failure' ? '#fb7185' : classify(r) === 'success' ? '#86efac' : '#67e8f9' }} />
                        <span className="text-zinc-200">{r.projectName}</span>
                        <span className="font-mono text-[11px] text-zinc-500">{r.id.slice(0, 8)}</span>
                      </div>
                      <span className="text-right font-mono tabular-nums text-zinc-300">{fmtTok(r.tokensInTotal + r.tokensOutTotal)}</span>
                      <span className="text-right font-mono tabular-nums text-zinc-500">{fmtUsd(projectedCost(r))}</span>
                      <span className="text-right font-mono tabular-nums text-zinc-500">{r.turnsTotal}t</span>
                      <span className="text-right font-mono text-zinc-500">{rel(r.startedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : !selected ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-zinc-500">
              select a project from the left rail
            </div>
          ) : (
            <div className="flex flex-col gap-4 px-6 pb-6 pt-5">
              {/* Hero with project meta */}
              <header className="flex flex-wrap items-end justify-between gap-3 border-b border-white/5 pb-3">
                <div className="min-w-0">
                  <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">{selected.name}</h2>
                  <p className="mt-1 line-clamp-2 max-w-prose text-[13px] text-zinc-400">{selected.goal}</p>
                </div>
                <Link
                  to={`/projects/${selected.id}`}
                  className="rounded-full border border-white/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-100 hover:bg-white/10"
                >
                  open ↗
                </Link>
              </header>

              {/* KILLER: Burn rate ETA panel — only when run live */}
              {liveRun && (
                <BurnRatePanel run={liveRun} />
              )}

              {/* Run lanes */}
              <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">in flight</div>
                  {selectedRuns.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length === 0 ? (
                    <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                      idle
                    </div>
                  ) : (
                    selectedRuns
                      .filter((r) => classify(r) === 'running' || classify(r) === 'paused')
                      .map((r) => <LiveCard key={r.id} run={r} />)
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">history</div>
                  <ul className="flex-1 overflow-hidden rounded-lg border border-white/10">
                    {selectedRuns
                      .filter((r) => classify(r) !== 'running' && classify(r) !== 'paused')
                      .slice(0, 8)
                      .map((r) => {
                        const c = classify(r);
                        const tone = c === 'failure' ? '#fb7185' : c === 'success' ? '#86efac' : '#71717a';
                        return (
                          <li key={r.id} className="border-b border-white/5 last:border-b-0">
                            <Link
                              to={`/projects/${r.projectId}/run/${r.id}`}
                              className="grid grid-cols-[1fr_72px_72px_60px] items-baseline gap-3 px-3 py-2 text-[12px] hover:bg-white/3"
                            >
                              <div className="flex items-center gap-2 truncate">
                                <span className="block h-1.5 w-1.5 flex-none rounded-full" style={{ background: tone }} />
                                <span className="font-mono text-zinc-200">{r.id.slice(0, 10)}</span>
                                <span className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: tone }}>{c}</span>
                              </div>
                              <span className="text-right font-mono tabular-nums text-zinc-300">{fmtTok(r.tokensInTotal + r.tokensOutTotal)}</span>
                              <span className="text-right font-mono tabular-nums text-zinc-500">{fmtUsd(projectedCost(r))}</span>
                              <span className="text-right font-mono text-zinc-500">{rel(r.startedAt)}</span>
                            </Link>
                          </li>
                        );
                      })}
                    {projectRunRows.data && projectRunRows.data.length === 0 && selectedRuns.length === 0 && (
                      <li className="px-4 py-6 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-500">
                        no runs yet
                      </li>
                    )}
                  </ul>
                </div>
              </section>
            </div>
          )}
        </main>

        {/* RIGHT — Agent chat rail */}
        <aside className="flex min-h-0 flex-col bg-[#08090b]">
          <header className="border-b border-white/5 px-4 py-2.5">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">agents</span>
              <span className="rounded-full bg-amber-400/15 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300">wip</span>
            </div>
            <div className="mt-1 truncate text-[12px] text-zinc-300">
              {mode === 'aggregate' ? 'cross-project' : selected?.name ?? '—'}
            </div>
          </header>
          <div className="flex-1 overflow-auto px-3 py-3">
            {team.data?.roles && team.data.roles.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {team.data.roles.map((role) => {
                  const key = role.role.toLowerCase().split(/[-_\s]/)[0] ?? 'developer';
                  const tone = ROLE_TONE[key] ?? '#86efac';
                  const isSel = activeAgent === role.role;
                  return (
                    <li key={role.role}>
                      <button
                        onClick={() => setActiveAgent(isSel ? null : role.role)}
                        className={`flex w-full items-center gap-2.5 rounded-md p-2 text-left ${isSel ? 'bg-white/8' : 'hover:bg-white/3'}`}
                      >
                        <span
                          className="grid h-7 w-7 flex-none place-items-center rounded-full text-[10px] font-bold uppercase"
                          style={{ background: `${tone}1f`, color: tone, border: `1px solid ${tone}40` }}
                        >
                          {role.role.slice(0, 2)}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[12px] font-medium text-zinc-100">@{role.role}</span>
                          <span className="font-mono text-[10px] text-zinc-500">{role.model}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="font-mono text-[11px] text-zinc-500">no team configured</div>
            )}
          </div>
          <div className="border-t border-white/5 p-3">
            <div className="rounded-lg border border-white/10 bg-white/3 p-2.5 focus-within:border-cyan-400/40">
              <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                <span>{activeAgent ? `to @${activeAgent}` : 'to team'}</span>
                <span>cmd+enter</span>
              </div>
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                rows={3}
                placeholder={liveRun ? `why is run ${liveRun.id.slice(0, 6)} burning so fast?` : 'ask anything…'}
                className="w-full resize-none border-0 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-zinc-500">+ context: {liveRun ? 'live run' : selected?.name ?? '—'}</span>
                <button className="rounded-full bg-cyan-500 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-500" disabled>
                  send · soon
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* footer */}
      <footer className="flex items-center justify-between border-t border-white/5 px-6 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400 pulse" /> ws
          </span>
          <span>rate-limit · ok</span>
          <span>v18 · cockpit²</span>
        </div>
        <div className="flex items-center gap-3">
          <span>tab · switch project</span>
          <span>cmd+/ · toggle mode</span>
          <span>cmd+k · search</span>
        </div>
      </footer>
    </div>
  );
}

function LiveCard({ run }: { run: GlobalRunRow }) {
  const c = classify(run);
  const tone = c === 'paused' ? '#fbbf24' : '#22d3ee';
  const burn = burnRateEta(run);
  const cost = projectedCost(run);
  const elapsedMin = elapsedSec(run) / 60;
  const budgetUsage = Math.min(100, (elapsedMin / run.budgetMinutes) * 100);
  return (
    <div className="rounded-lg border border-white/10 bg-white/3 p-3">
      <div className="flex items-baseline justify-between">
        <Link
          to={`/projects/${run.projectId}/run/${run.id}`}
          className="flex items-center gap-2 font-mono text-[12px] text-zinc-100 hover:underline"
        >
          <span className="block h-1.5 w-1.5 rounded-full pulse" style={{ background: tone }} />
          <span>{run.projectName}</span>
          <span className="text-zinc-500">{run.id.slice(0, 8)}</span>
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: tone }}>
          {c}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px] tabular-nums">
        <Field k="tok·in" v={fmtTok(run.tokensInTotal)} />
        <Field k="tok·out" v={fmtTok(run.tokensOutTotal)} />
        <Field k="turns" v={String(run.turnsTotal)} />
        <Field k="burn" v={`${Math.round(burn.tokPerMin)}/min`} tone="#67e8f9" />
        <Field k="eta" v={burn.etaText} tone={burn.etaText.includes('exceeded') ? '#fb7185' : '#67e8f9'} />
        <Field k="cost·est" v={fmtUsd(cost)} tone="#fbbf24" />
      </div>
      <div className="mt-2.5">
        <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          <span>budget {Math.round(elapsedMin)}m / {run.budgetMinutes}m</span>
          <span>{Math.round(budgetUsage)}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full rounded-full"
            style={{
              width: `${budgetUsage}%`,
              background: budgetUsage > 90 ? '#fb7185' : budgetUsage > 70 ? '#fbbf24' : '#22d3ee',
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BurnRatePanel({ run }: { run: GlobalRunRow }) {
  const burn = burnRateEta(run);
  const cost = projectedCost(run);
  const elapsedMin = elapsedSec(run) / 60;
  const budgetUsage = Math.min(100, (elapsedMin / run.budgetMinutes) * 100);
  const tone = burn.etaText.includes('exceeded') ? '#fb7185' : budgetUsage > 80 ? '#fbbf24' : '#22d3ee';
  return (
    <section
      className="rounded-xl border-2 p-4"
      style={{ borderColor: `${tone}66`, background: `${tone}0d` }}
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em]" style={{ color: tone }}>
            burn rate · live · run {run.id.slice(0, 8)}
          </div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">
            {Math.round(burn.tokPerMin).toLocaleString()}{' '}
            <span className="text-base font-normal text-zinc-400">tok/min</span>
          </div>
        </div>
        <div className="flex items-end gap-6 font-mono tabular-nums">
          <div className="flex flex-col items-end leading-none">
            <span className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">eta</span>
            <span className="mt-1 text-lg" style={{ color: tone }}>
              {burn.etaText}
            </span>
          </div>
          <div className="flex flex-col items-end leading-none">
            <span className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">cost·so·far</span>
            <span className="mt-1 text-lg text-amber-300">{fmtUsd(cost)}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/5">
        <div className="h-full" style={{ width: `${budgetUsage}%`, background: tone }} />
      </div>
    </section>
  );
}

function Field({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex flex-col leading-none">
      <span className="text-[9px] uppercase tracking-[0.22em] text-zinc-500">{k}</span>
      <span className="mt-1 text-zinc-100" style={{ color: tone }}>{v}</span>
    </div>
  );
}
