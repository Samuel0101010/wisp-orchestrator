import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const MUSTARD = '#d4a017';
const TEAL = '#0e6b6b';
const RUST = '#a44323';
const CREAM = '#efe6d2';
const INK = '#0c0a08';

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function classify(
  r: GlobalRunRow,
): 'running' | 'paused' | 'success' | 'failure' | 'cancelled' | 'pending' {
  if (r.status === 'running') return 'running';
  if (r.status === 'paused') return 'paused';
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded')
    return 'failure';
  if (r.status === 'completed') return 'success';
  return 'pending';
}

export function MissionControlV6Poster() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];

  const active = summary.data?.activeCount ?? 0;
  const total = summary.data?.totalRuns ?? 0;
  const success = summary.data?.outcomeCounts.success ?? 0;
  const successPct = total ? Math.round((success / total) * 100) : 0;
  const totalTok = summary.data?.totalTokens ?? 0;

  const tokensByDay = summary.data?.tokensByDay ?? [];
  const maxTok = Math.max(...tokensByDay.map((d) => d.tokens), 1);

  const projectStats = useMemo(() => {
    const map = new Map<string, GlobalRunRow[]>();
    data.forEach((r) => {
      const arr = map.get(r.projectName) ?? [];
      arr.push(r);
      map.set(r.projectName, arr);
    });
    return Array.from(map.entries())
      .map(([name, rs]) => ({
        name,
        count: rs.length,
        live: rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length,
        first: rs[0],
      }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const recent = data.slice(0, 8);

  return (
    <div
      data-mc-variant="poster"
      className="-m-6 min-h-[calc(100vh-3.5rem)]"
      style={{ background: CREAM, color: INK }}
    >
      <style>{`
        [data-mc-variant="poster"] {
          font-family: ui-sans-serif, "Helvetica Neue", "Helvetica", "Arial", sans-serif;
          font-feature-settings: "tnum","cv11";
        }
        [data-mc-variant="poster"] .mega {
          font-weight: 900;
          letter-spacing: -0.05em;
          line-height: 0.78;
          font-stretch: 90%;
        }
        [data-mc-variant="poster"] .stamp {
          font-family: ui-monospace, "SF Mono", "Menlo", monospace;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
        [data-mc-variant="poster"] .pill {
          display: inline-block;
          padding: 1px 8px;
          border-radius: 999px;
          background: currentColor;
          color: ${CREAM};
          font-size: 10px;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
      `}</style>

      <div className="px-8 pt-6">
        <VariantSwitcher tone="cream" />
      </div>

      <header className="border-y-2 border-stone-900 px-8 py-2">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.25em] text-stone-700 stamp">
          <span>Studio · agent-harness · 1962—now</span>
          <span>Pressing №{(total % 9999).toString().padStart(4, '0')}</span>
          <span>Side A · Mission Control</span>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-0">
        {/* Cell 1: Active runs — mustard, mega number */}
        <section
          className="col-span-12 flex flex-col justify-between border-b-2 border-r-0 border-stone-900 p-8 lg:col-span-7 lg:border-b-2 lg:border-r-2"
          style={{ background: MUSTARD, color: INK, minHeight: 480 }}
        >
          <div className="flex items-baseline justify-between">
            <span className="stamp text-[11px]">Now playing · in flight</span>
            <span className="stamp text-[11px]">
              {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
            </span>
          </div>
          <div className="mega self-start" style={{ fontSize: 'clamp(8rem, 22vw, 22rem)' }}>
            {String(active).padStart(2, '0')}
          </div>
          <div className="flex items-end justify-between gap-6">
            <div className="max-w-[44ch]">
              <div className="text-3xl font-black uppercase tracking-tight">
                {active === 0
                  ? 'all quiet on the line'
                  : active === 1
                    ? 'one run in flight'
                    : `${active} runs in flight`}
              </div>
              <div className="mt-1 text-sm text-stone-900/80">
                across {projectStats.length} projects on the books · {total} departures over the
                last seven days
              </div>
            </div>
            <div className="stamp text-[11px] text-stone-900/70">
              vol. 7d · ed. {Math.floor(Math.random() * 9 + 1)}
            </div>
          </div>
        </section>

        {/* Cell 2: Success rate — deep teal */}
        <section
          className="col-span-6 border-b-2 border-stone-900 p-7 lg:col-span-5 lg:border-l-0"
          style={{ background: TEAL, color: CREAM, minHeight: 240 }}
        >
          <div className="flex items-baseline justify-between">
            <span className="stamp text-[11px] opacity-70">B-side · success rate</span>
            <span className="stamp text-[11px] opacity-70">n={total}</span>
          </div>
          <div className="mt-2 mega" style={{ fontSize: 'clamp(5rem, 12vw, 11rem)' }}>
            {successPct}
            <span className="ml-2 align-top" style={{ fontSize: '0.4em', fontWeight: 800 }}>
              %
            </span>
          </div>
          <div className="mt-3 grid grid-cols-10 gap-1">
            {Array.from({ length: 10 }).map((_, i) => {
              const filled = i < Math.round(successPct / 10);
              return (
                <div
                  key={i}
                  className="aspect-square"
                  style={{
                    background: filled ? CREAM : 'transparent',
                    border: `2px solid ${CREAM}`,
                  }}
                  aria-hidden
                />
              );
            })}
          </div>
        </section>

        {/* Cell 3: Token throughput by day — rust, vertical bars */}
        <section
          className="col-span-12 flex flex-col gap-3 border-b-2 border-r-0 border-stone-900 p-7 lg:col-span-5 lg:border-r-2"
          style={{ background: RUST, color: CREAM, minHeight: 360 }}
        >
          <div className="flex items-baseline justify-between">
            <span className="stamp text-[11px] opacity-80">Track 03 · throughput · per day</span>
            <span className="stamp text-[11px] opacity-80">{fmtTok(totalTok)} total</span>
          </div>
          <div className="mt-3 flex flex-1 items-end gap-2">
            {tokensByDay.length === 0
              ? Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-2">
                    <div
                      className="w-full"
                      style={{ height: 8, background: 'rgba(239,230,210,0.25)' }}
                    />
                    <span className="stamp text-[9px] opacity-60">·</span>
                  </div>
                ))
              : tokensByDay.map((d) => {
                  const h = Math.max(8, (d.tokens / maxTok) * 200);
                  const day = new Date(d.day).toLocaleDateString('en-US', { weekday: 'short' });
                  return (
                    <div key={d.day} className="flex flex-1 flex-col items-stretch gap-2">
                      <div className="relative" style={{ height: 220 }}>
                        <div
                          className="absolute inset-x-0 bottom-0"
                          style={{ height: h, background: CREAM }}
                          title={`${day}: ${d.tokens.toLocaleString()}`}
                        />
                      </div>
                      <span className="stamp text-center text-[10px] opacity-80">{day}</span>
                    </div>
                  );
                })}
          </div>
        </section>

        {/* Cell 4: Recent runs — cream, ink list, type-as-architecture */}
        <section
          className="col-span-12 border-stone-900 p-7 lg:col-span-7 lg:border-l-0"
          style={{ background: CREAM, color: INK, minHeight: 360 }}
        >
          <div className="flex items-baseline justify-between">
            <span className="stamp text-[11px] text-stone-700">
              Track 04 · the docket · recent runs
            </span>
            <span className="stamp text-[11px] text-stone-700">{data.length} on file</span>
          </div>
          {recent.length === 0 ? (
            <div className="mt-6 text-2xl font-black uppercase italic text-stone-700">
              No departures recorded.
            </div>
          ) : (
            <ol className="mt-4 grid grid-cols-1 gap-y-1 md:grid-cols-2">
              {recent.map((r, i) => {
                const c = classify(r);
                const tone =
                  c === 'running' || c === 'paused'
                    ? RUST
                    : c === 'failure'
                      ? INK
                      : c === 'cancelled'
                        ? '#736a55'
                        : TEAL;
                return (
                  <li
                    key={r.id}
                    className="flex items-baseline gap-3 border-b border-stone-900/20 py-1.5"
                  >
                    <span className="w-7 text-right font-mono text-[12px] tabular-nums text-stone-600">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <Link
                      to={`/projects/${r.projectId}/run/${r.id}`}
                      className="flex flex-1 items-baseline gap-3 hover:opacity-70"
                    >
                      <span className="text-[15px] font-black uppercase tracking-tight">
                        {r.projectName}
                      </span>
                      <span className="font-mono text-[11px] text-stone-600">
                        {r.id.slice(0, 8)}
                      </span>
                      <span className="ml-auto stamp text-[10px]" style={{ color: tone }}>
                        {c}
                      </span>
                      <span className="font-mono text-[12px] tabular-nums text-stone-800">
                        {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <footer className="flex items-baseline justify-between border-t-2 border-stone-900 px-8 py-3 stamp text-[10px] text-stone-700">
        <span>Set in Helvetica Neue · printed locally · agent-harness studio</span>
        <span>side A · 1 of 1</span>
      </footer>
    </div>
  );
}
