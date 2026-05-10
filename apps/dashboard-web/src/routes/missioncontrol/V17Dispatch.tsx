import { useEffect, useMemo, useRef, useState } from 'react';
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

interface Suggestion {
  kind: 'run' | 'project' | 'agent' | 'action';
  label: string;
  detail: string;
  href?: string;
  icon: string;
}

export function MissionControlV17Dispatch() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const projects = useProjects();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const data = runs.data ?? [];

  const live = useMemo(
    () => data.filter((r) => classify(r) === 'running' || classify(r) === 'paused'),
    [data],
  );
  const recent = useMemo(
    () =>
      data
        .filter((r) => classify(r) === 'success' && r.endedAt)
        .slice(0, 12),
    [data],
  );
  const failures = useMemo(
    () => data.filter((r) => classify(r) === 'failure'),
    [data],
  );

  // Natural-language-to-action suggestions
  const suggestions: Suggestion[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Suggestion[] = [];
    if (q.length === 0) {
      out.push(
        { kind: 'action', label: 'Start a new run', detail: 'paste a goal · we wire the team', icon: '▶' },
        { kind: 'action', label: 'Resume paused runs', detail: `${data.filter((r) => r.status === 'paused').length} paused`, icon: '⏵' },
        { kind: 'action', label: 'Ask the architect', detail: '@architect · cross-project', icon: '@' },
      );
      (projects.data ?? []).slice(0, 3).forEach((p) => {
        out.push({ kind: 'project', label: `Open ${p.name}`, detail: 'project page', href: `/projects/${p.id}`, icon: '◆' });
      });
      live.slice(0, 3).forEach((r) => {
        out.push({
          kind: 'run',
          label: `Watch run ${r.id.slice(0, 8)}`,
          detail: `${r.projectName} · running ${rel(r.startedAt)}`,
          href: `/projects/${r.projectId}/run/${r.id}`,
          icon: '●',
        });
      });
      return out;
    }

    // crude NLP — match keywords
    if (/start|run|new|kick/i.test(q)) {
      out.push({
        kind: 'action',
        label: `Start a run: "${query}"`,
        detail: 'create project + wire team + generate plan',
        icon: '▶',
      });
    }
    if (/ask|why|how|@/i.test(q)) {
      const agent = q.match(/@(\w+)/)?.[1] ?? 'architect';
      out.push({
        kind: 'agent',
        label: `Ask @${agent}: "${query.replace(/^@\w+\s*/, '')}"`,
        detail: 'send to agent · response inline',
        icon: '@',
      });
    }
    (projects.data ?? []).forEach((p) => {
      if (p.name.toLowerCase().includes(q) || p.goal.toLowerCase().includes(q)) {
        out.push({
          kind: 'project',
          label: `Open ${p.name}`,
          detail: p.goal.slice(0, 60),
          href: `/projects/${p.id}`,
          icon: '◆',
        });
      }
    });
    data.forEach((r) => {
      if (r.id.toLowerCase().includes(q) || r.projectName.toLowerCase().includes(q)) {
        out.push({
          kind: 'run',
          label: `run ${r.id.slice(0, 10)}`,
          detail: `${r.projectName} · ${classify(r)} · ${rel(r.startedAt)}`,
          href: `/projects/${r.projectId}/run/${r.id}`,
          icon: '●',
        });
      }
    });
    return out.slice(0, 8);
  }, [query, data, live, projects.data]);

  return (
    <div
      data-mc-variant="dispatch"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_auto_1fr_auto]"
      style={{
        background:
          'radial-gradient(ellipse at top, #1c1d22 0%, #0c0d10 60%, #08090b 100%)',
        color: '#e4e4e7',
      }}
    >
      <style>{`
        [data-mc-variant="dispatch"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="dispatch"] .glow-input:focus-within {
          box-shadow: 0 0 0 6px rgba(103,232,249,0.12), inset 0 0 0 1px rgba(103,232,249,0.5);
        }
        [data-mc-variant="dispatch"] .lane-card {
          transition: transform 200ms cubic-bezier(0.32,0.72,0,1), border-color 200ms;
        }
        [data-mc-variant="dispatch"] .lane-card:hover {
          transform: translateY(-2px);
          border-color: rgba(103,232,249,0.5);
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="c" />
      </div>

      {/* HUGE Cmd-K input */}
      <header className="px-6 pt-4">
        <div className="mx-auto max-w-4xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
            dispatch · type to act
          </div>
          <div className="glow-input mt-2 rounded-2xl border border-white/10 bg-white/3 p-4 transition-shadow">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-cyan-500/15 font-mono text-[14px] text-cyan-300">
                ⌘K
              </span>
              <textarea
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="start a refactor crew on apps/dashboard-web · or @architect why is run 7e8a stuck · or todo"
                rows={2}
                className="flex-1 resize-none border-0 bg-transparent text-lg leading-snug text-zinc-50 outline-none placeholder:text-zinc-600"
              />
              {query.length > 0 && (
                <button
                  onClick={() => setQuery('')}
                  className="font-mono text-[11px] text-zinc-500 hover:text-zinc-200"
                  aria-label="clear"
                >
                  esc ✕
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
              <span>{suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'}</span>
              <span>↑↓ navigate · enter act · @ for agent · / for command</span>
            </div>
          </div>

          {/* Suggestions */}
          <ul className="mt-3 flex flex-col">
            {suggestions.map((s, i) => {
              const tone =
                s.kind === 'action' ? '#67e8f9' : s.kind === 'agent' ? '#c084fc' : s.kind === 'run' ? '#34d399' : '#fbbf24';
              const Inner = (
                <>
                  <span
                    className="grid h-8 w-8 flex-none place-items-center rounded-md font-mono text-[14px]"
                    style={{ background: `${tone}1f`, color: tone }}
                  >
                    {s.icon}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-[14px] text-zinc-100">{s.label}</span>
                    <span className="truncate font-mono text-[11px] text-zinc-500">{s.detail}</span>
                  </div>
                  <span className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                    {s.kind}
                  </span>
                  <span className="font-mono text-[11px] text-zinc-500">↵</span>
                </>
              );
              const cls = `lane-card flex items-center gap-3 rounded-lg border border-white/5 bg-white/2 px-3 py-2 ${i === 0 ? 'border-white/15 bg-white/5' : ''}`;
              return (
                <li key={`${s.kind}-${s.label}-${i}`} className="mt-1">
                  {s.href ? (
                    <Link to={s.href} className={cls}>
                      {Inner}
                    </Link>
                  ) : (
                    <button className={`${cls} w-full text-left`}>{Inner}</button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </header>

      {/* 3 LANES — Now / Recent / Failures */}
      <div className="grid min-h-0 grid-cols-1 gap-4 overflow-hidden px-6 pt-6 lg:grid-cols-3">
        <Lane title="Now · live" tone="#22d3ee" emptyText="nothing running" runs={live} />
        <Lane title="Done · 7d" tone="#34d399" emptyText="no completions yet" runs={recent} />
        <Lane title="Triage" tone="#fb7185" emptyText="all clear" runs={failures} accent />
      </div>

      {/* Footer KPI */}
      <footer className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-white/5 bg-black/40 px-6 py-2 backdrop-blur">
        <div className="flex items-center gap-6 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          <span>cross-project</span>
          {[
            { k: 'live', v: summary.data?.activeCount ?? 0, tone: '#22d3ee' },
            { k: 'runs/7d', v: summary.data?.totalRuns ?? 0 },
            { k: 'tok/7d', v: fmtTok(summary.data?.totalTokens ?? 0) },
            { k: 'ok', v: `${Math.round((summary.data?.successRate ?? 0) * 100)}%` },
            { k: 'projects', v: projects.data?.length ?? 0 },
          ].map((s) => (
            <span key={s.k} className="text-zinc-300">
              {s.k} <span className="font-semibold text-zinc-100" style={{ color: s.tone }}>{s.v}</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          <span>v17 · dispatch</span>
          <Link to="/" className="text-zinc-300 hover:text-zinc-100">/ home</Link>
        </div>
      </footer>
    </div>
  );
}

function Lane({
  title,
  tone,
  emptyText,
  runs,
  accent,
}: {
  title: string;
  tone: string;
  emptyText: string;
  runs: GlobalRunRow[];
  accent?: boolean;
}) {
  return (
    <section className="flex min-h-0 flex-col rounded-lg border border-white/10 bg-white/3">
      <header className="flex items-baseline justify-between border-b border-white/5 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em]" style={{ color: tone }}>
          {title}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-zinc-500">{runs.length}</span>
      </header>
      <div className="flex-1 overflow-auto p-2">
        {runs.length === 0 ? (
          <div className="flex h-full items-center justify-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-600">
            {emptyText}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.slice(0, 8).map((r) => (
              <li key={r.id}>
                <Link
                  to={`/projects/${r.projectId}/run/${r.id}`}
                  className="lane-card block rounded-md border bg-white/2 p-2.5"
                  style={{ borderColor: accent ? `${tone}40` : 'rgba(255,255,255,0.05)' }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="block h-1.5 w-1.5 flex-none rounded-full" style={{ background: tone }} />
                    <span className="truncate text-[13px] font-medium text-zinc-100">{r.projectName}</span>
                    <span className="ml-auto font-mono text-[10px] text-zinc-500">{rel(r.startedAt)}</span>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between font-mono text-[11px] tabular-nums text-zinc-500">
                    <span>{r.id.slice(0, 8)}</span>
                    <span>
                      {fmtTok(r.tokensInTotal + r.tokensOutTotal)} · {r.turnsTotal}t
                    </span>
                  </div>
                  {accent && (
                    <div className="mt-2 rounded bg-rose-500/10 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-rose-300">
                      ↩ ask architect to triage
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
