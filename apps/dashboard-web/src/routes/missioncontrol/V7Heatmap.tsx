import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const PAPER = '#fbf6ec';
const INK = '#0e1320';
const COBALT = '#1d3d8a';

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

interface Cell {
  project: string;
  projectId: string;
  bucketIndex: number;
  dayOffset: number;
  quarter: number;
  runs: GlobalRunRow[];
  tokens: number;
}

const QUARTERS = ['00–06', '06–12', '12–18', '18–24'];
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function dayOffsetOf(d: Date, today: Date): number {
  const td = new Date(today);
  td.setHours(0, 0, 0, 0);
  const dd = new Date(d);
  dd.setHours(0, 0, 0, 0);
  return Math.floor((dd.getTime() - td.getTime()) / 86_400_000);
}

export function MissionControlV7Heatmap() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];
  const [hover, setHover] = useState<Cell | null>(null);

  const today = useMemo(() => new Date(), []);
  const projects = useMemo(() => {
    const map = new Map<string, { id: string; runs: GlobalRunRow[] }>();
    data.forEach((r) => {
      const e = map.get(r.projectName) ?? { id: r.projectId, runs: [] };
      e.runs.push(r);
      map.set(r.projectName, e);
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1].runs.length - a[1].runs.length)
      .slice(0, 12);
  }, [data]);

  const grid: Cell[][] = useMemo(() => {
    return projects.map(([name, { id, runs }]) => {
      const row: Cell[] = [];
      for (let day = -6; day <= 0; day++) {
        for (let q = 0; q < 4; q++) {
          row.push({
            project: name,
            projectId: id,
            bucketIndex: (day + 6) * 4 + q,
            dayOffset: day,
            quarter: q,
            runs: [],
            tokens: 0,
          });
        }
      }
      runs.forEach((r) => {
        if (!r.startedAt) return;
        const d = new Date(r.startedAt as string);
        const off = dayOffsetOf(d, today);
        if (off < -6 || off > 0) return;
        const q = Math.min(3, Math.floor(d.getHours() / 6));
        const idx = (off + 6) * 4 + q;
        const cell = row[idx];
        if (!cell) return;
        cell.runs.push(r);
        cell.tokens += r.tokensInTotal + r.tokensOutTotal;
      });
      return row;
    });
  }, [projects, today]);

  const maxTok = useMemo(() => {
    let m = 1;
    grid.forEach((row) => row.forEach((c) => (m = Math.max(m, c.tokens))));
    return m;
  }, [grid]);

  function shade(t: number): string {
    if (t === 0) return 'transparent';
    const ratio = Math.min(1, Math.log10(1 + t) / Math.log10(1 + maxTok));
    const alpha = 0.08 + ratio * 0.85;
    return `rgba(29,61,138,${alpha.toFixed(3)})`;
  }

  return (
    <div
      data-mc-variant="heatmap"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-8 pb-12 pt-6"
      style={{ background: PAPER, color: INK }}
    >
      <style>{`
        [data-mc-variant="heatmap"] {
          font-family: ui-sans-serif, "Inter", "Helvetica Neue", sans-serif;
          font-feature-settings: "tnum","ss01";
        }
        [data-mc-variant="heatmap"] .micro {
          font-family: ui-monospace, "SF Mono", "Menlo", monospace;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          font-size: 10px;
        }
        [data-mc-variant="heatmap"] .cell { transition: transform 80ms ease-out; }
        [data-mc-variant="heatmap"] .cell:hover { transform: scale(1.06); }
      `}</style>

      <VariantSwitcher tone="paper" />

      <header className="border-b border-stone-900/40 pb-3">
        <div className="micro text-stone-700">field log · agent-harness · density survey</div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">
          Token density by project, day, and quarter-day
        </h1>
        <div className="mt-1 max-w-[80ch] text-[14px] text-stone-700">
          Each cell is six hours of one project. Saturation maps to logarithmic token volume in that
          window; an empty cell is a quiet quarter, a fully-saturated cell is the busiest in the
          survey.
        </div>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: 880 }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-[#fbf6ec] py-2 text-left">
                  <span className="micro text-stone-600">project</span>
                </th>
                {Array.from({ length: 7 }).map((_, di) => {
                  const d = new Date(today);
                  d.setDate(d.getDate() + (di - 6));
                  const isToday = di === 6;
                  return (
                    <th
                      key={di}
                      colSpan={4}
                      className="border-l border-stone-900/40 px-2 pb-1 pt-2 text-left"
                    >
                      <div className="flex items-baseline gap-2">
                        <span
                          className={`text-base font-bold tabular-nums ${isToday ? 'text-stone-900' : 'text-stone-700'}`}
                        >
                          {d.getDate()}
                        </span>
                        <span className="micro text-stone-600">
                          {DAY_LABELS[d.getDay() === 0 ? 6 : d.getDay() - 1]}
                          {isToday ? ' · TODAY' : ''}
                        </span>
                      </div>
                    </th>
                  );
                })}
                <th className="border-l border-stone-900/40 pb-1 pl-3 pt-2 text-right">
                  <span className="micro text-stone-600">total</span>
                </th>
              </tr>
              <tr>
                <td className="sticky left-0 z-10 bg-[#fbf6ec]" />
                {Array.from({ length: 7 }).map((_, di) =>
                  QUARTERS.map((q, qi) => (
                    <td
                      key={`${di}-${qi}`}
                      className={`pb-1 pt-0.5 ${qi === 0 ? 'border-l border-stone-900/40' : ''}`}
                    >
                      <span className="micro text-[8px] text-stone-500">{q}</span>
                    </td>
                  )),
                )}
                <td />
              </tr>
            </thead>
            <tbody>
              {grid.length === 0 ? (
                <tr>
                  <td colSpan={30} className="py-6 italic text-stone-600">
                    No projects on record.
                  </td>
                </tr>
              ) : (
                grid.map((row, ri) => {
                  const projectName = projects[ri]?.[0] ?? '';
                  const totalTok = row.reduce((s, c) => s + c.tokens, 0);
                  return (
                    <tr key={projectName} className="border-t border-stone-900/15">
                      <td className="sticky left-0 z-10 bg-[#fbf6ec] py-2 pr-3">
                        <div className="flex flex-col">
                          <span className="text-[14px] font-semibold text-stone-900">
                            {projectName}
                          </span>
                          <span className="micro text-stone-600">
                            {row.reduce((s, c) => s + c.runs.length, 0)} runs
                          </span>
                        </div>
                      </td>
                      {row.map((c, ci) => {
                        const isQuarterStart = c.quarter === 0;
                        const isHover =
                          hover?.project === c.project && hover?.bucketIndex === c.bucketIndex;
                        return (
                          <td
                            key={ci}
                            className={`align-middle ${isQuarterStart ? 'border-l border-stone-900/40' : ''}`}
                            style={{ padding: 1 }}
                          >
                            <div
                              className="cell relative aspect-square w-5"
                              style={{
                                background: shade(c.tokens),
                                outline: isHover ? `2px solid ${COBALT}` : 'none',
                                outlineOffset: isHover ? -1 : 0,
                              }}
                              onMouseEnter={() => setHover(c)}
                              onMouseLeave={() => setHover(null)}
                              role="button"
                              tabIndex={c.runs.length > 0 ? 0 : -1}
                              aria-label={`${c.project} · day ${c.dayOffset} · ${QUARTERS[c.quarter]} · ${c.runs.length} runs · ${c.tokens} tokens`}
                            />
                          </td>
                        );
                      })}
                      <td className="border-l border-stone-900/40 px-3 text-right font-mono text-[12px] tabular-nums">
                        {fmtTok(totalTok)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <aside className="flex flex-col gap-4">
          <div className="border border-stone-900/40 bg-white/40 p-4">
            <div className="micro mb-2 text-stone-700">window summary</div>
            <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
              <dt className="text-stone-700">Runs total</dt>
              <dd className="text-right font-bold tabular-nums">{summary.data?.totalRuns ?? 0}</dd>
              <dt className="text-stone-700">Tokens routed</dt>
              <dd className="text-right font-bold tabular-nums">
                {fmtTok(summary.data?.totalTokens ?? 0)}
              </dd>
              <dt className="text-stone-700">Active right now</dt>
              <dd className="text-right font-bold tabular-nums">
                {summary.data?.activeCount ?? 0}
              </dd>
              <dt className="text-stone-700">Success rate</dt>
              <dd className="text-right font-bold tabular-nums">
                {Math.round((summary.data?.successRate ?? 0) * 100)}%
              </dd>
            </dl>
          </div>

          <div className="border border-stone-900/40 bg-white/40 p-4">
            <div className="micro mb-2 text-stone-700">density scale (log)</div>
            <div className="flex items-center gap-1">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="h-4 w-6"
                  style={{ background: shade((maxTok / 8) * (i + 1)) }}
                  aria-hidden
                />
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[10px] text-stone-600">
              <span className="micro">low</span>
              <span className="micro">{fmtTok(maxTok)}</span>
            </div>
          </div>

          <div className="border border-stone-900/40 bg-white/40 p-4">
            <div className="micro mb-2 text-stone-700">selection</div>
            {hover ? (
              <div className="flex flex-col gap-1.5 text-[12px]">
                <div className="text-[14px] font-semibold text-stone-900">{hover.project}</div>
                <div className="text-stone-700">
                  {hover.dayOffset === 0
                    ? 'today'
                    : `${Math.abs(hover.dayOffset)} day${Math.abs(hover.dayOffset) === 1 ? '' : 's'} ago`}{' '}
                  · {QUARTERS[hover.quarter]}h
                </div>
                <div className="font-mono">
                  {hover.runs.length} run{hover.runs.length === 1 ? '' : 's'} ·{' '}
                  {fmtTok(hover.tokens)} tok
                </div>
                {hover.runs[0] && (
                  <Link
                    to={`/projects/${hover.runs[0].projectId}/run/${hover.runs[0].id}`}
                    className="mt-2 inline-flex items-center justify-between border border-stone-900 px-2 py-1 text-[11px] uppercase tracking-[0.2em] text-stone-900 hover:bg-stone-900 hover:text-[#fbf6ec]"
                  >
                    Open first run
                    <span>↗</span>
                  </Link>
                )}
              </div>
            ) : (
              <div className="text-[12px] italic text-stone-600">Hover a cell to inspect.</div>
            )}
          </div>
        </aside>
      </section>

      <footer className="mt-10 border-t border-stone-900/40 pt-3 micro text-stone-700">
        Density survey · cells in 6-hour bins · log-scale saturation · agent-harness
      </footer>
    </div>
  );
}
