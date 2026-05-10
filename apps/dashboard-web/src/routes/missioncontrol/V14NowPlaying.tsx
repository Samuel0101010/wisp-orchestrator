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

const HUES = [22, 168, 268, 318, 88, 198, 358, 138];

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

function fmtTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function durationOf(r: GlobalRunRow): number {
  if (!r.startedAt) return 0;
  const start = new Date(r.startedAt as string).getTime();
  const end = r.endedAt ? new Date(r.endedAt as string).getTime() : Date.now();
  return Math.max(0, (end - start) / 1000);
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

export function MissionControlV14NowPlaying() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const projMap = useMemo(() => {
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
      const al = (projMap.get(a.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      const bl = (projMap.get(b.id) ?? []).filter(
        (r) => classify(r) === 'running' || classify(r) === 'paused',
      ).length;
      return bl - al;
    });
  }, [projects.data, projMap]);

  useEffect(() => {
    if (selectedId == null && sortedProjects.length > 0) {
      const firstActive = sortedProjects.find((p) =>
        (projMap.get(p.id) ?? []).some((r) => classify(r) === 'running' || classify(r) === 'paused'),
      );
      setSelectedId(firstActive?.id ?? sortedProjects[0]?.id ?? null);
    }
  }, [selectedId, sortedProjects, projMap]);

  const selected = sortedProjects.find((p) => p.id === selectedId) ?? null;
  const selectedRuns = selectedId ? projMap.get(selectedId) ?? [] : [];
  const team = useTeam(selectedId ?? undefined);
  const projectRuns = useProjectRuns(selectedId ?? undefined);

  const allLive = useMemo(
    () => (globalRuns.data ?? []).filter((r) => classify(r) === 'running' || classify(r) === 'paused'),
    [globalRuns.data],
  );
  const nowPlaying = allLive[0] ?? null;
  const elapsed = nowPlaying ? durationOf(nowPlaying) : 0;
  const budgetSec = nowPlaying ? nowPlaying.budgetMinutes * 60 : 0;
  const progress = budgetSec > 0 ? Math.min(100, (elapsed / budgetSec) * 100) : 0;

  // Tick every second so "now playing" timer updates
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const projectHue = selectedId
    ? HUES[(sortedProjects.findIndex((p) => p.id === selectedId) % HUES.length + HUES.length) % HUES.length] ?? 22
    : 22;

  return (
    <div
      data-mc-variant="nowplaying"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_minmax(0,1fr)_auto] [color-scheme:dark]"
      style={{ background: '#0a0a0a', color: '#e7e5e4' }}
    >
      <style>{`
        [data-mc-variant="nowplaying"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="nowplaying"] .gradient-bg {
          background:
            radial-gradient(ellipse 80% 50% at 0% 0%, hsla(var(--hue) 70% 45% / 0.35), transparent 65%),
            #18120e;
          transition: background 600ms ease-out;
        }
        [data-mc-variant="nowplaying"] .marquee-now {
          animation: nowplay-pulse 2.4s ease-in-out infinite;
        }
        @keyframes nowplay-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="nowplaying"] .marquee-now { animation: none; }
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="b" />
      </div>

      {/* MAIN — 3 col: library | spread | discography */}
      <div className="grid min-h-0 grid-cols-[260px_minmax(0,1fr)_280px] gap-px bg-white/5">
        {/* LEFT — library */}
        <aside className="flex min-h-0 flex-col bg-[#0a0a0a]">
          <div className="px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-500">
              your library
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
              <span className="font-mono text-[10px] tabular-nums text-stone-500">
                {sortedProjects.length}
              </span>
            </div>
          </div>
          <ul className="flex-1 overflow-auto px-2 pb-2">
            {sortedProjects.length === 0 && (
              <li className="px-2 py-6 text-[12px] italic text-stone-500">
                Empty library. Add a project to start.
              </li>
            )}
            {sortedProjects.map((p, i) => {
              const rs = projMap.get(p.id) ?? [];
              const live = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length;
              const isSel = selectedId === p.id;
              const hue = HUES[i % HUES.length] ?? 22;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => setSelectedId(p.id)}
                    className={`group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors ${isSel ? 'bg-white/10' : 'hover:bg-white/5'}`}
                  >
                    {/* album-cover-square */}
                    <span
                      className="grid h-10 w-10 flex-none place-items-center rounded text-[14px] font-bold uppercase"
                      style={{
                        background: `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 30) % 360} 70% 30%))`,
                        color: 'white',
                      }}
                    >
                      {p.name.slice(0, 2)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-[13px] font-medium text-stone-100">{p.name}</span>
                      <span className="truncate font-mono text-[10px] text-stone-500">
                        {rs.length} run{rs.length === 1 ? '' : 's'}
                      </span>
                    </span>
                    {live > 0 && (
                      <span className="flex flex-col items-end leading-none">
                        <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400 marquee-now" />
                        <span className="mt-1 font-mono text-[9px] tabular-nums text-emerald-400">
                          {live}
                        </span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-white/5 px-4 py-3">
            <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
              <span>library stats</span>
              <span>7d</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
              <Stat k="Active" v={String(summary.data?.activeCount ?? 0)} tone={(summary.data?.activeCount ?? 0) > 0 ? '#34d399' : undefined} />
              <Stat k="Runs" v={String(summary.data?.totalRuns ?? 0)} />
              <Stat k="Tok" v={fmtTok(summary.data?.totalTokens ?? 0)} />
              <Stat k="OK" v={`${Math.round((summary.data?.successRate ?? 0) * 100)}%`} />
            </div>
          </div>
        </aside>

        {/* CENTER — project spread */}
        <main
          className="gradient-bg min-h-0 overflow-auto"
          style={{ ['--hue' as string]: projectHue } as React.CSSProperties}
        >
          {selected ? (
            <div className="flex min-h-full flex-col">
              {/* hero */}
              <header className="flex items-end gap-6 px-8 pb-8 pt-12">
                <div
                  className="grid h-44 w-44 flex-none place-items-center rounded-md text-5xl font-extrabold uppercase tracking-tight shadow-2xl"
                  style={{
                    background: `linear-gradient(135deg, hsl(${projectHue} 70% 45%), hsl(${(projectHue + 30) % 360} 70% 28%))`,
                    color: 'white',
                  }}
                >
                  {selected.name.slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-300">
                    project · long play
                  </div>
                  <h1 className="mt-1 text-[clamp(2.5rem,6vw,4.5rem)] font-extrabold leading-[0.95] tracking-tight text-white">
                    {selected.name}
                  </h1>
                  <p className="mt-2 line-clamp-2 max-w-prose text-[14px] text-stone-300">
                    {selected.goal}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.22em] text-stone-300">
                    <span>{selectedRuns.length} runs on file</span>
                    <span>·</span>
                    <span style={{ color: selectedRuns.some((r) => classify(r) === 'running') ? '#34d399' : undefined }}>
                      {selectedRuns.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length} live
                    </span>
                    <span>·</span>
                    <span>tok {fmtTok(selectedRuns.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0))}</span>
                    <span>·</span>
                    <Link
                      to={`/projects/${selected.id}`}
                      className="rounded-full border border-white/30 px-3 py-1 text-stone-100 hover:bg-white/10"
                    >
                      open project ↗
                    </Link>
                  </div>
                </div>
              </header>

              {/* tracks */}
              <section className="flex-1 px-8 pb-12">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-lg font-semibold tracking-tight">Tracks · runs in order</h2>
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                    {projectRuns.data?.length ?? selectedRuns.length} total
                  </span>
                </div>
                <div className="overflow-hidden rounded-md border border-white/5">
                  <div className="grid grid-cols-[28px_1fr_56px_72px_72px_56px] items-center gap-3 bg-white/5 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-400">
                    <span>#</span>
                    <span>id</span>
                    <span className="text-right">turns</span>
                    <span className="text-right">tok</span>
                    <span className="text-right">duration</span>
                    <span className="text-right">state</span>
                  </div>
                  {selectedRuns.length === 0 ? (
                    <div className="px-4 py-6 italic text-stone-500">No tracks on this project yet.</div>
                  ) : (
                    <ul>
                      {selectedRuns.map((r, i) => {
                        const c = classify(r);
                        const tone =
                          c === 'running' || c === 'paused'
                            ? '#34d399'
                            : c === 'failure'
                              ? '#f87171'
                              : c === 'success'
                                ? '#a7f3d0'
                                : '#a8a29e';
                        return (
                          <li
                            key={r.id}
                            className="grid grid-cols-[28px_1fr_56px_72px_72px_56px] items-center gap-3 border-b border-white/5 px-4 py-2 hover:bg-white/5 last:border-b-0"
                          >
                            <span className="font-mono text-[11px] tabular-nums text-stone-500">
                              {String(i + 1).padStart(2, '0')}
                            </span>
                            <Link
                              to={`/projects/${r.projectId}/run/${r.id}`}
                              className="flex items-center gap-2 truncate font-mono text-[12px] text-stone-100 hover:underline"
                            >
                              {(c === 'running' || c === 'paused') && (
                                <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400 marquee-now" />
                              )}
                              {r.id.slice(0, 10)}
                            </Link>
                            <span className="text-right font-mono tabular-nums text-stone-400">
                              {r.turnsTotal}
                            </span>
                            <span className="text-right font-mono tabular-nums text-stone-300">
                              {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                            </span>
                            <span className="text-right font-mono tabular-nums text-stone-400">
                              {fmtTime(durationOf(r))}
                            </span>
                            <span
                              className="text-right font-mono text-[10px] uppercase tracking-[0.18em]"
                              style={{ color: tone }}
                            >
                              {c}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </section>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[14px] italic text-stone-500">
              Pick a project from your library.
            </div>
          )}
        </main>

        {/* RIGHT — discography (= team agents) */}
        <aside className="flex min-h-0 flex-col bg-[#0a0a0a]">
          <div className="border-b border-white/5 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-500">
                credits · agents
              </span>
              <span className="rounded-full bg-amber-400/15 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.22em] text-amber-300">
                chat · soon
              </span>
            </div>
            <div className="mt-1 text-[12px] text-stone-400">
              {selected ? `On ${selected.name}` : 'No project selected'}
            </div>
          </div>
          <div className="flex-1 overflow-auto px-3 py-3">
            {team.data?.roles && team.data.roles.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {team.data.roles.map((role) => {
                  const tone =
                    role.role.toLowerCase().includes('architect')
                      ? '#67e8f9'
                      : role.role.toLowerCase().includes('qa') || role.role.toLowerCase().includes('review')
                        ? '#fcd34d'
                        : '#86efac';
                  return (
                    <li key={role.role} className="flex flex-col gap-2 rounded-md bg-white/5 p-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="grid h-9 w-9 flex-none place-items-center rounded-full text-[12px] font-bold uppercase"
                          style={{ background: `${tone}1f`, color: tone, border: `1px solid ${tone}40` }}
                        >
                          {role.role.slice(0, 2)}
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[13px] font-medium text-stone-100">{role.role}</span>
                          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
                            {role.model}
                          </span>
                        </div>
                      </div>
                      <p className="line-clamp-3 text-[11px] text-stone-400">
                        {role.systemPrompt.slice(0, 160)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="rounded-md border border-dashed border-white/10 p-4 text-center text-[12px] italic text-stone-500">
                {selected ? (
                  <>
                    No team configured.{' '}
                    <Link to={`/projects/${selected.id}/teams`} className="text-amber-300 hover:underline">
                      Configure →
                    </Link>
                  </>
                ) : (
                  <>Pick a project to see its agents.</>
                )}
              </div>
            )}
          </div>
          <div className="border-t border-white/5 p-3">
            <div className="cursor-not-allowed rounded-md bg-white/5 p-3">
              <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                <span>liner notes</span>
                <span>v14</span>
              </div>
              <div className="font-mono text-[11px] text-stone-500">
                @architect · what changed since the last run?
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* BOTTOM — Now Playing dock */}
      <footer className="border-t border-white/5 bg-[#0a0a0a]/95 px-4 py-3 backdrop-blur">
        {nowPlaying ? (
          <div className="grid grid-cols-[1fr_2fr_1fr] items-center gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span
                className="grid h-12 w-12 flex-none place-items-center rounded text-[12px] font-bold uppercase"
                style={{
                  background: `linear-gradient(135deg, hsl(${HUES[(sortedProjects.findIndex((p) => p.id === nowPlaying.projectId) % HUES.length + HUES.length) % HUES.length] ?? 22} 70% 45%), hsl(${(HUES[(sortedProjects.findIndex((p) => p.id === nowPlaying.projectId) % HUES.length + HUES.length) % HUES.length] ?? 22) + 30} 70% 28%))`,
                  color: 'white',
                }}
              >
                {nowPlaying.projectName.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <Link
                  to={`/projects/${nowPlaying.projectId}/run/${nowPlaying.id}`}
                  className="flex items-center gap-2 truncate text-[13px] font-medium text-stone-100 hover:underline"
                >
                  <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400 marquee-now" />
                  Run {nowPlaying.id.slice(0, 8)}
                </Link>
                <div className="truncate font-mono text-[11px] text-stone-400">
                  {nowPlaying.projectName}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-stretch gap-1">
              <div className="flex items-center justify-center gap-3">
                <button className="rounded-full p-1.5 text-stone-400 hover:text-stone-100" disabled aria-label="Previous">
                  <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor"><path d="M3 2v12M14 2L5 8l9 6V2z" /></svg>
                </button>
                <button className="grid h-9 w-9 place-items-center rounded-full bg-white text-black hover:scale-105" aria-label="Pause" disabled>
                  <svg width={14} height={14} viewBox="0 0 14 14" fill="currentColor"><path d="M3 2h3v10H3zM8 2h3v10H8z" /></svg>
                </button>
                <button className="rounded-full p-1.5 text-stone-400 hover:text-stone-100" disabled aria-label="Next">
                  <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor"><path d="M13 2v12M2 2l9 6-9 6V2z" /></svg>
                </button>
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums text-stone-400">
                <span>{fmtTime(elapsed)}</span>
                <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="absolute left-0 top-0 h-full rounded-full bg-emerald-400"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <span>budget {nowPlaying.budgetMinutes}:00</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-4 font-mono text-[11px] tabular-nums text-stone-400">
              <span>{nowPlaying.turnsTotal} turns</span>
              <span>tok {fmtTok(nowPlaying.tokensInTotal + nowPlaying.tokensOutTotal)}</span>
              <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-emerald-300">
                {classify(nowPlaying)}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="grid h-12 w-12 place-items-center rounded bg-white/10 text-stone-500">
                ♪
              </span>
              <div>
                <div className="text-[13px] font-medium text-stone-300">Nothing playing</div>
                <div className="font-mono text-[11px] text-stone-500">
                  No live runs across {sortedProjects.length} projects
                </div>
              </div>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
              v14 · now playing
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex flex-col rounded-md bg-white/5 px-2 py-1.5 leading-none">
      <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-stone-500">{k}</span>
      <span className="mt-0.5 font-mono text-[13px] tabular-nums" style={{ color: tone ?? '#e7e5e4' }}>
        {v}
      </span>
    </div>
  );
}
