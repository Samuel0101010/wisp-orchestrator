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

function rel(d: string | Date | null | undefined | number) {
  if (!d && d !== 0) return '—';
  const t = typeof d === 'number' ? d : typeof d === 'string' ? new Date(d).getTime() : (d as Date).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

function durationOf(r: GlobalRunRow): number {
  if (!r.startedAt) return 0;
  const start = new Date(r.startedAt as string).getTime();
  const end = r.endedAt ? new Date(r.endedAt as string).getTime() : Date.now();
  return Math.max(0, (end - start) / 1000);
}

interface TriageItem {
  kind: 'failure' | 'paused' | 'rate-limit' | 'anomaly';
  run: GlobalRunRow;
  message: string;
  action: string;
  tone: string;
}

export function MissionControlV20Inbox() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const projects = useProjects();

  const data = runs.data ?? [];

  const projectStats = useMemo(() => {
    const m = new Map<string, { mean: number; std: number; n: number }>();
    const byProj = new Map<string, number[]>();
    data.forEach((r) => {
      if (r.status !== 'completed' || !r.endedAt) return;
      const arr = byProj.get(r.projectId) ?? [];
      arr.push(durationOf(r));
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
  }, [data]);

  const triage: TriageItem[] = useMemo(() => {
    const items: TriageItem[] = [];
    data.forEach((r) => {
      const c = classify(r);
      if (c === 'failure') {
        items.push({
          kind: 'failure',
          run: r,
          message: `Run failed${r.outcome === 'budget_exceeded' ? ' — budget exceeded' : ''}`,
          action: 'Ask qa to triage',
          tone: '#fb7185',
        });
      } else if (c === 'paused' && r.pausedReason === 'rate-limit') {
        items.push({
          kind: 'rate-limit',
          run: r,
          message: `Paused on rate-limit${r.resumeAt ? ` · resumes ${rel(r.resumeAt as string)}` : ''}`,
          action: 'Will auto-resume',
          tone: '#fbbf24',
        });
      } else if (c === 'paused') {
        items.push({
          kind: 'paused',
          run: r,
          message: `Paused — ${r.pausedReason ?? 'manual'}`,
          action: 'Resume',
          tone: '#fbbf24',
        });
      } else if (c === 'running') {
        const stats = projectStats.get(r.projectId);
        const dur = durationOf(r);
        if (stats && stats.std > 0 && stats.n >= 3) {
          const z = (dur - stats.mean) / stats.std;
          if (z > 2.5) {
            items.push({
              kind: 'anomaly',
              run: r,
              message: `Running ${z.toFixed(1)}σ longer than peers`,
              action: 'Inspect — possibly stuck',
              tone: '#c084fc',
            });
          }
        }
      }
    });
    // sort: failure → rate-limit → paused → anomaly
    const order: Record<TriageItem['kind'], number> = { failure: 0, 'rate-limit': 1, paused: 2, anomaly: 3 };
    items.sort((a, b) => order[a.kind] - order[b.kind]);
    return items;
  }, [data, projectStats]);

  const inFlight = data.filter((r) => classify(r) === 'running');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const doneToday = data.filter((r) => {
    if (!r.endedAt) return false;
    const c = classify(r);
    if (c !== 'success' && c !== 'failure') return false;
    return new Date(r.endedAt as string).getTime() >= today.getTime();
  });

  const [composer, setComposer] = useState('');
  const [activeAgent, setActiveAgent] = useState<string | null>(null);

  return (
    <div
      data-mc-variant="inbox"
      className="-m-6 grid h-[calc(100vh-3.5rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto]"
      style={{ background: '#fafaf9', color: '#0a0a0a' }}
    >
      <style>{`
        [data-mc-variant="inbox"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01","cv11";
        }
        [data-mc-variant="inbox"] .row { transition: background 80ms; }
        [data-mc-variant="inbox"] .row:hover { background: rgba(0,0,0,0.02); }
        [data-mc-variant="inbox"] .quick { opacity: 0; transition: opacity 80ms; }
        [data-mc-variant="inbox"] .row:hover .quick { opacity: 1; }
      `}</style>

      <div className="px-6 pt-4">
        <VariantSwitcher tone="paper" set="c" />
      </div>

      {/* Top zen header */}
      <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b border-stone-200 px-6 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-500">
            inbox · {triage.length === 0 ? 'all clear' : `${triage.length} item${triage.length === 1 ? '' : 's'} need attention`}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-900">
            {triage.length === 0
              ? "You're caught up. Nothing to do."
              : triage.length === 1
                ? "One thing needs you."
                : `${triage.length} things need you.`}
          </h1>
        </div>
        <div className="flex items-end gap-6 font-mono text-[11px] tabular-nums text-stone-700">
          {[
            { k: 'live', v: summary.data?.activeCount ?? 0, tone: '#0e7490' },
            { k: 'runs/7d', v: summary.data?.totalRuns ?? 0 },
            { k: 'tok/7d', v: fmtTok(summary.data?.totalTokens ?? 0) },
            { k: 'ok', v: `${Math.round((summary.data?.successRate ?? 0) * 100)}%` },
            { k: 'projects', v: projects.data?.length ?? 0 },
          ].map((s) => (
            <div key={s.k} className="flex flex-col items-end leading-none">
              <span className="text-[9px] uppercase tracking-[0.22em] text-stone-500">{s.k}</span>
              <span className="mt-1 text-[15px] font-semibold text-stone-900" style={{ color: s.tone }}>
                {s.v}
              </span>
            </div>
          ))}
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_320px] overflow-hidden">
        <main className="min-h-0 overflow-auto px-6 pt-5 pb-6">
          {/* TRIAGE section */}
          {triage.length > 0 && (
            <section className="mb-6">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-rose-700">
                  triage · {triage.length}
                </h2>
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500">
                  surfaced by system
                </span>
              </div>
              <ul className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                {triage.map((t) => (
                  <li
                    key={`${t.kind}-${t.run.id}`}
                    className="row group grid grid-cols-[8px_1fr_auto] items-center gap-3 border-b border-stone-100 px-4 py-2.5 last:border-b-0"
                  >
                    <span className="block h-1.5 w-1.5 rounded-full" style={{ background: t.tone }} />
                    <Link
                      to={`/projects/${t.run.projectId}/run/${t.run.id}`}
                      className="flex min-w-0 flex-col gap-0.5"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-[14px] font-semibold tracking-tight text-stone-900">
                          {t.run.projectName}
                        </span>
                        <span className="text-[14px] text-stone-700">{t.message}</span>
                        <span className="font-mono text-[11px] text-stone-500">
                          run {t.run.id.slice(0, 8)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 font-mono text-[11px] text-stone-500">
                        <span>tok {fmtTok(t.run.tokensInTotal + t.run.tokensOutTotal)}</span>
                        <span>turns {t.run.turnsTotal}</span>
                        <span>started {rel(t.run.startedAt)}</span>
                        <span
                          className="rounded-full px-1.5 py-px text-[9px] uppercase tracking-[0.18em]"
                          style={{ background: `${t.tone}1f`, color: t.tone }}
                        >
                          {t.kind}
                        </span>
                      </div>
                    </Link>
                    <div className="quick flex items-center gap-2">
                      <button
                        className="rounded-full border border-stone-300 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700 hover:bg-stone-900 hover:text-white"
                        title="Resolve / dismiss this triage item"
                      >
                        ✓ done
                      </button>
                      <button
                        className="rounded-full bg-stone-900 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white hover:bg-stone-700"
                        title="Suggested action"
                      >
                        {t.action}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* In progress */}
          <section className="mb-6">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-700">
                in progress · {inFlight.length}
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500">
                live runs
              </span>
            </div>
            {inFlight.length === 0 ? (
              <div className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-6 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-stone-500">
                idle · nothing running
              </div>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                {inFlight.map((r) => {
                  const elapsedMin = durationOf(r) / 60;
                  const usage = Math.min(100, (elapsedMin / r.budgetMinutes) * 100);
                  return (
                    <li
                      key={r.id}
                      className="row grid grid-cols-[8px_1fr_140px_auto] items-center gap-3 border-b border-stone-100 px-4 py-2.5 last:border-b-0"
                    >
                      <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500" />
                      <Link
                        to={`/projects/${r.projectId}/run/${r.id}`}
                        className="flex flex-col gap-0.5 min-w-0"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[14px] font-semibold tracking-tight">{r.projectName}</span>
                          <span className="font-mono text-[11px] text-stone-500">{r.id.slice(0, 8)}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 font-mono text-[11px] text-stone-500">
                          <span>tok {fmtTok(r.tokensInTotal + r.tokensOutTotal)}</span>
                          <span>turns {r.turnsTotal}</span>
                          <span>{Math.round(elapsedMin)}m / {r.budgetMinutes}m budget</span>
                        </div>
                      </Link>
                      <div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-stone-200">
                          <div
                            className="h-full"
                            style={{
                              width: `${usage}%`,
                              background: usage > 90 ? '#dc2626' : usage > 70 ? '#d97706' : '#0891b2',
                            }}
                          />
                        </div>
                        <div className="mt-0.5 text-right font-mono text-[10px] tabular-nums text-stone-500">
                          {Math.round(usage)}%
                        </div>
                      </div>
                      <span className="font-mono text-[11px] text-stone-500">{rel(r.startedAt)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Done today */}
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-700">
                done today · {doneToday.length}
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-500">
                completed since 00:00
              </span>
            </div>
            {doneToday.length === 0 ? (
              <div className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-6 text-center font-mono text-[11px] uppercase tracking-[0.22em] text-stone-500">
                nothing closed today yet
              </div>
            ) : (
              <ul className="overflow-hidden rounded-lg border border-stone-200 bg-white">
                {doneToday.slice(0, 12).map((r) => {
                  const c = classify(r);
                  return (
                    <li
                      key={r.id}
                      className="row grid grid-cols-[8px_1fr_72px_60px_60px_auto] items-baseline gap-3 border-b border-stone-100 px-4 py-2 last:border-b-0"
                    >
                      <span
                        className="block h-1.5 w-1.5 rounded-full"
                        style={{ background: c === 'failure' ? '#fb7185' : '#10b981' }}
                      />
                      <Link
                        to={`/projects/${r.projectId}/run/${r.id}`}
                        className="flex items-baseline gap-2 truncate text-[13px]"
                      >
                        <span className="font-semibold tracking-tight">{r.projectName}</span>
                        <span className="font-mono text-[11px] text-stone-500">{r.id.slice(0, 8)}</span>
                      </Link>
                      <span
                        className="text-right font-mono text-[10px] uppercase tracking-[0.18em]"
                        style={{ color: c === 'failure' ? '#dc2626' : '#047857' }}
                      >
                        {c}
                      </span>
                      <span className="text-right font-mono tabular-nums text-stone-700">
                        {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                      </span>
                      <span className="text-right font-mono tabular-nums text-stone-500">{r.turnsTotal}t</span>
                      <span className="font-mono text-[11px] text-stone-500">{rel(r.endedAt)} ago</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-stone-200 bg-white">
          <header className="border-b border-stone-200 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-500">agents</span>
              <span className="rounded-full bg-amber-100 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-800">
                wip
              </span>
            </div>
          </header>
          <div className="flex-1 overflow-auto px-3 py-3">
            <ul className="flex flex-col gap-1">
              {['architect', 'core-dev', 'test-dev', 'qa'].map((a) => {
                const isSel = activeAgent === a;
                return (
                  <li key={a}>
                    <button
                      onClick={() => setActiveAgent(isSel ? null : a)}
                      className={`flex w-full items-center gap-2 rounded-md p-2 text-left ${isSel ? 'bg-stone-100' : 'hover:bg-stone-50'}`}
                    >
                      <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-stone-100 font-mono text-[10px] uppercase">
                        {a.slice(0, 2)}
                      </span>
                      <span className="flex-1 text-[13px]">@{a}</span>
                      <span className="font-mono text-[10px] text-stone-500">→</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3 text-[12px] text-stone-700">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                inbox tip
              </div>
              <p className="mt-1">
                Items appear here only when something needs you. The agents handle the rest.
              </p>
            </div>
          </div>
          <div className="border-t border-stone-200 p-3">
            <div className="rounded-lg border border-stone-300 bg-white p-2.5 focus-within:border-stone-900">
              <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                {activeAgent ? `to @${activeAgent}` : 'ask the team'}
              </div>
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                rows={3}
                placeholder={triage[0] ? `why did ${triage[0].run.projectName} fail?` : 'ask anything…'}
                className="w-full resize-none border-0 bg-transparent text-[12px] outline-none placeholder:text-stone-400"
              />
              <div className="flex items-center justify-between font-mono text-[10px] text-stone-500">
                <span>cmd+enter</span>
                <span>v20 · inbox</span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer className="flex items-center justify-between border-t border-stone-200 bg-white px-6 py-2 font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" /> ws · live
          </span>
          <span>rate-limit · ok</span>
          <span>v1.2.0</span>
        </div>
        <div>j/k navigate · e archive · r reply · cmd+k search</div>
      </footer>
    </div>
  );
}
