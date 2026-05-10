import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const LINE_COLORS = [
  '#c0392b',
  '#0e7c66',
  '#caa12a',
  '#2c3a8a',
  '#a8593b',
  '#5c4d8a',
  '#3d6b3d',
  '#7a3a4f',
];

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

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function shortId(id: string) {
  return id.slice(0, 6).toUpperCase();
}

interface Line {
  project: string;
  projectId: string;
  color: string;
  runs: GlobalRunRow[];
}

export function MissionControlV5Transit() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const lines: Line[] = useMemo(() => {
    const map = new Map<string, GlobalRunRow[]>();
    data.forEach((r) => {
      const arr = map.get(r.projectName) ?? [];
      arr.push(r);
      map.set(r.projectName, arr);
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([project, rs], i) => ({
        project,
        projectId: rs[0]?.projectId ?? '',
        color: LINE_COLORS[i % LINE_COLORS.length] ?? '#1c1917',
        runs: [...rs].sort(
          (x, y) =>
            new Date(x.startedAt as string).getTime() - new Date(y.startedAt as string).getTime(),
        ),
      }));
  }, [data]);

  const now = Date.now();
  const windowMs = 7 * 24 * 3_600_000;
  const left = 200;
  const right = 80;
  const lineHeight = 56;
  const top = 96;
  const totalH = top + lines.length * lineHeight + 96;
  const totalW = 1200;

  function xOf(t: number): number {
    const age = Math.max(0, now - t);
    const ratio = 1 - Math.min(age, windowMs) / windowMs;
    return left + ratio * (totalW - left - right);
  }

  const selected = selectedId ? data.find((r) => r.id === selectedId) : null;
  const selectedLine = selected ? lines.find((l) => l.project === selected.projectName) : null;

  return (
    <div
      data-mc-variant="transit"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-10 pb-12 pt-6"
      style={{ background: '#f4eada', color: '#1a1410' }}
    >
      <style>{`
        [data-mc-variant="transit"] {
          font-family: ui-sans-serif, "Helvetica Neue", "Helvetica", "Arial", sans-serif;
          font-feature-settings: "tnum","ss01";
        }
        [data-mc-variant="transit"] .station { cursor: pointer; transition: r 120ms ease-out; }
        [data-mc-variant="transit"] .station:hover { r: 11; }
        [data-mc-variant="transit"] .label-line { font-weight: 700; letter-spacing: -0.01em; }
        [data-mc-variant="transit"] .terminus {
          font-family: ui-monospace, "SF Mono", "Menlo", monospace;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          font-size: 10px;
        }
      `}</style>

      <VariantSwitcher tone="paper" />

      <header className="grid grid-cols-[1fr_auto] items-end gap-6 border-b-2 border-stone-900 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-stone-700">
            agent-harness · operations · system map
          </div>
          <h1
            className="mt-1 text-5xl font-black leading-[0.9] tracking-tight text-stone-900"
            style={{ fontStretch: '90%', letterSpacing: '-0.025em' }}
          >
            The Harness Line Map
            <span className="ml-3 align-middle text-xl font-medium text-stone-600">
              · last 7 days · {data.length} departures
            </span>
          </h1>
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] uppercase tracking-[0.22em] text-stone-700">
          <span>
            Edition ·{' '}
            {new Date().toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
              year: '2-digit',
            })}
          </span>
          <span className="font-mono text-[10px]">network · {lines.length} lines</span>
        </div>
      </header>

      <section className="mt-6 overflow-x-auto rounded-[3px] border border-stone-900/40 bg-[#fbf3df]">
        <svg
          viewBox={`0 0 ${totalW} ${totalH}`}
          className="block w-full"
          style={{ minWidth: 980 }}
          role="img"
          aria-label="Transit-map of agent runs over time"
        >
          {/* time axis */}
          <line
            x1={left}
            x2={totalW - right}
            y1={top - 36}
            y2={top - 36}
            stroke="#1a1410"
            strokeWidth={1}
          />
          {Array.from({ length: 8 }).map((_, i) => {
            const x = left + (i / 7) * (totalW - left - right);
            const days = 7 - i;
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={top - 40} y2={top - 32} stroke="#1a1410" strokeWidth={1} />
                <text
                  x={x}
                  y={top - 50}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#1a1410"
                  className="terminus"
                >
                  {days === 0 ? 'NOW' : `${days}D AGO`}
                </text>
              </g>
            );
          })}

          {/* lines */}
          {lines.map((line, i) => {
            const y = top + i * lineHeight + lineHeight / 2;
            const xStart = left;
            const xEnd = totalW - right;
            return (
              <g key={line.project}>
                {/* terminus disc — left */}
                <circle
                  cx={xStart - 28}
                  cy={y}
                  r={14}
                  fill="#fbf3df"
                  stroke={line.color}
                  strokeWidth={3}
                />
                <text
                  x={xStart - 28}
                  y={y + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fill={line.color}
                  fontWeight={800}
                  letterSpacing="0.05em"
                >
                  {String(i + 1).padStart(2, '0')}
                </text>

                {/* line */}
                <line
                  x1={xStart}
                  x2={xEnd}
                  y1={y}
                  y2={y}
                  stroke={line.color}
                  strokeWidth={9}
                  strokeLinecap="round"
                />
                {/* faint inner stripe for line texture */}
                <line
                  x1={xStart}
                  x2={xEnd}
                  y1={y}
                  y2={y}
                  stroke="rgba(255,255,255,0.25)"
                  strokeWidth={1.5}
                />

                {/* line label (project name) */}
                <text
                  x={xStart - 50}
                  y={y + 4}
                  textAnchor="end"
                  fontSize={14}
                  className="label-line"
                  fill="#1a1410"
                >
                  {line.project}
                </text>

                {/* stations */}
                {line.runs.map((r) => {
                  const x = xOf(new Date(r.startedAt as string).getTime());
                  const cls = classify(r);
                  const fill =
                    cls === 'failure'
                      ? '#1a1410'
                      : cls === 'cancelled'
                        ? '#fbf3df'
                        : cls === 'running' || cls === 'paused'
                          ? line.color
                          : '#fbf3df';
                  const stroke = cls === 'failure' ? line.color : line.color;
                  const isSel = selectedId === r.id;
                  const isLive = cls === 'running' || cls === 'paused';
                  return (
                    <g
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      onMouseEnter={() => setSelectedId(r.id)}
                    >
                      {isLive && (
                        <circle
                          cx={x}
                          cy={y}
                          r={14}
                          fill="none"
                          stroke={line.color}
                          strokeOpacity={0.35}
                          strokeWidth={1}
                        >
                          <animate
                            attributeName="r"
                            values="9;15;9"
                            dur="2.4s"
                            repeatCount="indefinite"
                          />
                          <animate
                            attributeName="stroke-opacity"
                            values="0.45;0;0.45"
                            dur="2.4s"
                            repeatCount="indefinite"
                          />
                        </circle>
                      )}
                      <circle
                        cx={x}
                        cy={y}
                        r={isSel ? 10 : 8}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={3}
                        className="station"
                      />
                      {cls === 'failure' && (
                        <>
                          <line
                            x1={x - 4}
                            y1={y - 4}
                            x2={x + 4}
                            y2={y + 4}
                            stroke="#fbf3df"
                            strokeWidth={2}
                          />
                          <line
                            x1={x - 4}
                            y1={y + 4}
                            x2={x + 4}
                            y2={y - 4}
                            stroke="#fbf3df"
                            strokeWidth={2}
                          />
                        </>
                      )}
                      {(isSel || isLive) && (
                        <text
                          x={x}
                          y={y - 16}
                          textAnchor="middle"
                          fontSize={9}
                          fill={line.color}
                          letterSpacing="0.12em"
                          fontWeight={700}
                        >
                          {shortId(r.id)}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* terminus disc — right */}
                <circle cx={xEnd + 28} cy={y} r={6} fill={line.color} />
                <text x={xEnd + 40} y={y + 4} fontSize={11} fill="#1a1410" className="terminus">
                  {line.runs.length} stops
                </text>
              </g>
            );
          })}

          {/* legend strip */}
          <g transform={`translate(${left}, ${top + lines.length * lineHeight + 32})`}>
            <text x={0} y={0} fontSize={10} fill="#1a1410" className="terminus">
              station legend ·
            </text>
            <Legend cx={120} fill="#fbf3df" stroke="#1a1410" label="OPEN (succeeded)" />
            <Legend cx={300} fill="#1a1410" stroke="#1a1410" label="OUT OF SERVICE (failed)" />
            <Legend cx={520} fill="#1a1410" stroke="#1a1410" label="EN ROUTE (running)" pulse />
            <Legend cx={720} fill="#fbf3df" stroke="#1a1410" label="CANCELLED" cancel />
          </g>
        </svg>
      </section>

      {/* Stats and detail panel */}
      <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="border-2 border-stone-900 bg-[#fbf3df] px-5 py-4">
          <div className="flex items-baseline justify-between border-b border-stone-900/30 pb-2">
            <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-stone-900">
              Service report · seven days
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-700">
              all lines combined
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-4 gap-x-6 gap-y-3">
            <Cell k="Departures" v={String(summary.data?.totalRuns ?? 0)} />
            <Cell k="In transit" v={String(summary.data?.activeCount ?? 0)} />
            <Cell k="On time" v={`${Math.round((summary.data?.successRate ?? 0) * 100)}%`} />
            <Cell k="Tokens routed" v={fmtTok(summary.data?.totalTokens ?? 0)} />
          </dl>
        </div>

        <div className="border-2 border-stone-900 bg-[#fbf3df] px-5 py-4">
          <div className="flex items-baseline justify-between border-b border-stone-900/30 pb-2">
            <h2 className="text-sm font-bold uppercase tracking-[0.22em] text-stone-900">
              Station detail
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-700">
              {selected ? shortId(selected.id) : '——————'}
            </span>
          </div>
          {selected && selectedLine ? (
            <div className="mt-3 flex flex-col gap-1.5 text-[13px]">
              <div className="flex items-center gap-3">
                <span
                  className="inline-block h-3 w-9"
                  style={{ background: selectedLine.color }}
                  aria-hidden
                />
                <span className="font-bold">{selected.projectName}</span>
              </div>
              <Row k="status" v={selected.status} />
              <Row k="tokens.in" v={fmtTok(selected.tokensInTotal)} />
              <Row k="tokens.out" v={fmtTok(selected.tokensOutTotal)} />
              <Row k="turns" v={String(selected.turnsTotal)} />
              <Row
                k="started"
                v={
                  selected.startedAt ? new Date(selected.startedAt as string).toLocaleString() : '—'
                }
              />
              <Link
                to={`/projects/${selected.projectId}/run/${selected.id}`}
                className="mt-3 inline-flex w-full items-center justify-between border-2 border-stone-900 bg-stone-900 px-3 py-2 text-[11px] uppercase tracking-[0.25em] text-[#fbf3df] hover:bg-stone-800"
              >
                Open station
                <span>↗</span>
              </Link>
            </div>
          ) : (
            <div className="mt-4 font-serif italic text-stone-600">
              Select a station on the map to see its timetable.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <dt className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-700">{k}</dt>
      <dd className="text-3xl font-black tabular-nums leading-none tracking-tight text-stone-900">
        {v}
      </dd>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-900/15 pb-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-700">{k}</span>
      <span className="font-mono text-[12px] tabular-nums text-stone-900">{v}</span>
    </div>
  );
}

function Legend({
  cx,
  fill,
  stroke,
  label,
  pulse,
  cancel,
}: {
  cx: number;
  fill: string;
  stroke: string;
  label: string;
  pulse?: boolean;
  cancel?: boolean;
}) {
  return (
    <g transform={`translate(${cx}, 16)`}>
      <circle cx={0} cy={0} r={6} fill={fill} stroke={stroke} strokeWidth={2}>
        {pulse && (
          <animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite" />
        )}
      </circle>
      {cancel && (
        <>
          <line x1={-4} y1={0} x2={4} y2={0} stroke={stroke} strokeWidth={1.5} />
        </>
      )}
      <text
        x={14}
        y={4}
        fontSize={10}
        fill="#1a1410"
        letterSpacing="0.12em"
        style={{ textTransform: 'uppercase' }}
      >
        {label}
      </text>
    </g>
  );
}
