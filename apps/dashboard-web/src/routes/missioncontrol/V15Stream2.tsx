import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useProjects, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const PROJECT_HUES = [218, 158, 18, 268, 38, 338, 198, 88];
const LS_LAST_VISIT = 'mc-stream2-last-visit';

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

function rel(t: number) {
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

function clock(t: number) {
  return new Date(t).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface Event {
  ts: number;
  kind: 'started' | 'closed' | 'paused' | 'failed';
  run: GlobalRunRow;
  hue: number;
}

export function MissionControlV15Stream2() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const projects = useProjects();

  const projectHue = useMemo(() => {
    const m = new Map<string, number>();
    (projects.data ?? []).forEach((p, i) =>
      m.set(p.id, PROJECT_HUES[i % PROJECT_HUES.length] ?? 200),
    );
    return m;
  }, [projects.data]);

  // since-last-visit
  const lastVisitRef = useRef<number>(Date.now());
  useEffect(() => {
    try {
      const stored = parseInt(localStorage.getItem(LS_LAST_VISIT) || '0', 10);
      if (stored > 0) lastVisitRef.current = stored;
      const onUnload = () => {
        try {
          localStorage.setItem(LS_LAST_VISIT, String(Date.now()));
        } catch {
          /* storage unavailable */
        }
      };
      window.addEventListener('beforeunload', onUnload);
      const writeNow = setInterval(onUnload, 30_000);
      return () => {
        clearInterval(writeNow);
        window.removeEventListener('beforeunload', onUnload);
        onUnload();
      };
    } catch {
      /* ignore */
    }
  }, []);

  const events: Event[] = useMemo(() => {
    const out: Event[] = [];
    (runs.data ?? []).forEach((r) => {
      const hue = projectHue.get(r.projectId) ?? 200;
      if (r.startedAt) {
        out.push({ ts: new Date(r.startedAt as string).getTime(), kind: 'started', run: r, hue });
      }
      if (r.endedAt) {
        const c = classify(r);
        out.push({
          ts: new Date(r.endedAt as string).getTime(),
          kind: c === 'failure' ? 'failed' : 'closed',
          run: r,
          hue,
        });
      } else if (r.pausedReason) {
        out.push({
          ts: r.startedAt ? new Date(r.startedAt as string).getTime() + 30_000 : Date.now(),
          kind: 'paused',
          run: r,
          hue,
        });
      }
    });
    return out.sort((a, b) => b.ts - a.ts);
  }, [runs.data, projectHue]);

  const sinceLast = events.filter((e) => e.ts > lastVisitRef.current);
  const before = events.filter((e) => e.ts <= lastVisitRef.current);

  // chat composer
  const [composer, setComposer] = useState('');
  const [activeAgent, setActiveAgent] = useState<string | null>('architect');

  return (
    <div
      data-mc-variant="stream2"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] [color-scheme:dark]"
      style={{ background: '#08090b', color: '#e4e4e7' }}
    >
      <style>{`
        [data-mc-variant="stream2"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="stream2"] .row { transition: background 120ms ease-out; }
        [data-mc-variant="stream2"] .row:hover { background: rgba(255,255,255,0.04); }
        [data-mc-variant="stream2"] .reply-btn { opacity: 0; transition: opacity 80ms; }
        [data-mc-variant="stream2"] .row:hover .reply-btn { opacity: 1; }
        [data-mc-variant="stream2"] .pulse { animation: stream-pulse 2s ease-in-out infinite; }
        @keyframes stream-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="stream2"] .pulse { animation: none; }
        }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="dark" set="c" />
      </div>

      {/* TOP — title + KPI strip + filters */}
      <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b border-white/5 px-6 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
            stream² · activity feed
          </div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
              {sinceLast.length > 0
                ? `${sinceLast.length} new event${sinceLast.length === 1 ? '' : 's'} since you left`
                : 'All caught up'}
            </h1>
            <span className="font-mono text-[11px] text-zinc-500">
              {sinceLast.length > 0
                ? `last seen ${rel(lastVisitRef.current)}`
                : `${events.length} events on file`}
            </span>
          </div>
        </div>
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
              <span className="mt-1 text-[15px] text-zinc-100" style={{ color: s.tone }}>
                {s.v}
              </span>
            </div>
          ))}
        </div>
      </header>

      {/* BODY — feed + chat dock */}
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_360px] gap-px bg-white/5">
        <main className="min-h-0 overflow-auto bg-[#08090b]">
          {events.length === 0 ? (
            <div className="flex h-full items-center justify-center font-mono text-[12px] text-zinc-500">
              no events yet — kick off a run to see activity here.
            </div>
          ) : (
            <ol>
              {sinceLast.length > 0 && (
                <li className="sticky top-0 z-10 flex items-center gap-3 border-b border-cyan-400/30 bg-cyan-400/5 px-6 py-2 backdrop-blur">
                  <span className="block h-2 w-2 rounded-full bg-cyan-400 pulse" />
                  <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-cyan-300">
                    new since {clock(lastVisitRef.current)} · {sinceLast.length} event
                    {sinceLast.length === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={() => {
                      try {
                        localStorage.setItem(LS_LAST_VISIT, String(Date.now()));
                      } catch {
                        /* storage unavailable */
                      }
                      lastVisitRef.current = Date.now();
                    }}
                    className="ml-auto rounded-full border border-cyan-400/30 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200 hover:bg-cyan-400/10"
                  >
                    mark caught up ✓
                  </button>
                </li>
              )}
              {sinceLast.map((e) => (
                <EventRow key={`${e.run.id}-${e.kind}-${e.ts}`} e={e} fresh />
              ))}
              {sinceLast.length > 0 && before.length > 0 && (
                <li className="border-y border-white/5 bg-white/3 px-6 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  ↓ already seen
                </li>
              )}
              {before.slice(0, 80).map((e) => (
                <EventRow key={`${e.run.id}-${e.kind}-${e.ts}`} e={e} />
              ))}
            </ol>
          )}
        </main>

        {/* CHAT RAIL */}
        <aside className="flex min-h-0 flex-col bg-[#08090b]">
          <div className="border-b border-white/5 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-500">
                agents
              </span>
              <span className="rounded-full bg-amber-400/15 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-300">
                wip
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['architect', 'core-dev', 'test-dev', 'qa'].map((a) => (
                <button
                  key={a}
                  onClick={() => setActiveAgent(a)}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-tight ${activeAgent === a ? 'bg-cyan-400/20 text-cyan-200' : 'text-zinc-400 hover:text-zinc-100'}`}
                >
                  @{a}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-auto px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
              recent threads
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {sinceLast.slice(0, 4).map((e) => (
                <li
                  key={`thr-${e.run.id}-${e.kind}-${e.ts}`}
                  className="rounded-md bg-white/5 p-2.5"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-[12px] font-medium text-zinc-200">
                      re: run {e.run.id.slice(0, 6)}
                    </span>
                    <span className="font-mono text-[10px] text-zinc-500">{rel(e.ts)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">
                    {e.kind === 'failed'
                      ? `agent flagged failure on ${e.run.projectName} — open thread to triage`
                      : e.kind === 'paused'
                        ? `paused on ${e.run.pausedReason ?? 'unknown'}, agent waiting on you`
                        : `${e.kind} — ${fmtTok(e.run.tokensInTotal + e.run.tokensOutTotal)} tok consumed`}
                  </p>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-white/5 p-3">
            <div className="rounded-lg border border-white/10 bg-white/3 p-2.5 focus-within:border-cyan-400/40">
              <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                <span>to @{activeAgent ?? 'team'}</span>
                <span>cmd+enter</span>
              </div>
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                placeholder={`ask @${activeAgent ?? 'team'} something…`}
                rows={3}
                className="w-full resize-none border-0 bg-transparent font-sans text-[12px] text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              <div className="mt-1 flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <button
                    className="rounded p-1 text-zinc-500 hover:text-zinc-200"
                    title="attach context"
                  >
                    📎
                  </button>
                  <span className="font-mono text-[10px] text-zinc-500">
                    + context: cross-project
                  </span>
                </div>
                <button
                  className="rounded-full bg-cyan-500 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-950 disabled:bg-zinc-700 disabled:text-zinc-500"
                  disabled
                >
                  send · soon
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* FOOTER — persistence signals */}
      <footer className="flex items-center justify-between border-t border-white/5 px-6 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-1.5 rounded-full bg-emerald-400 pulse" />
            ws · live
          </span>
          <span>rate-limit · ok</span>
          <span>v1.2.0</span>
        </div>
        <div className="flex items-center gap-3">
          <span>cmd+k · search</span>
          <span>j/k · navigate</span>
          <span>r · reply</span>
        </div>
      </footer>
    </div>
  );
}

function EventRow({ e, fresh }: { e: Event; fresh?: boolean }) {
  const verb =
    e.kind === 'started'
      ? 'launched'
      : e.kind === 'failed'
        ? 'failed'
        : e.kind === 'paused'
          ? 'paused'
          : 'closed cleanly';
  const tone =
    e.kind === 'failed'
      ? '#fb7185'
      : e.kind === 'paused'
        ? '#fbbf24'
        : e.kind === 'closed'
          ? '#86efac'
          : '#67e8f9';
  return (
    <li className="row group grid grid-cols-[20px_1fr_auto] items-baseline gap-x-4 border-b border-white/5 px-6 py-2.5">
      <span className="relative flex justify-center" aria-hidden>
        <span
          className="absolute -top-2.5 bottom-0 w-px"
          style={{ background: `hsl(${e.hue} 50% 50% / 0.4)` }}
        />
        <span
          className="relative top-1.5 block h-2 w-2 rounded-full"
          style={{ background: `hsl(${e.hue} 60% 50%)` }}
        />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
          <Link
            to={`/projects/${e.run.projectId}`}
            className="font-semibold tracking-tight hover:underline"
            style={{ color: `hsl(${e.hue} 60% 65%)` }}
          >
            {e.run.projectName}
          </Link>
          <span className="text-zinc-300">{verb}</span>
          <Link
            to={`/projects/${e.run.projectId}/run/${e.run.id}`}
            className="font-mono text-[11px] text-zinc-500 hover:text-zinc-100"
          >
            run {e.run.id.slice(0, 8)}
          </Link>
          {fresh && (
            <span className="rounded-full border border-cyan-400/30 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-cyan-300">
              new
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] text-zinc-500">
          <span>tok·in {fmtTok(e.run.tokensInTotal)}</span>
          <span>tok·out {fmtTok(e.run.tokensOutTotal)}</span>
          <span>turns {e.run.turnsTotal}</span>
          {e.run.pausedReason && (
            <span className="rounded-full bg-amber-400/15 px-1.5 py-px text-amber-300">
              {e.run.pausedReason}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">{rel(e.ts)}</span>
        <span className="font-mono text-[9px] uppercase tracking-[0.18em]" style={{ color: tone }}>
          {e.kind}
        </span>
        <button
          className="reply-btn rounded-full border border-white/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-400 hover:bg-white/10"
          title="reply to this thread (chat coming)"
        >
          ↩ reply
        </button>
      </div>
    </li>
  );
}
