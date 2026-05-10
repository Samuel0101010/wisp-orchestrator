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

function rel(d: string | Date | null | undefined) {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d).getTime() : (d as Date).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

interface Hex {
  id: string;
  name: string;
  goal: string;
  q: number;
  r: number;
  cx: number;
  cy: number;
  size: number;
  liveCount: number;
  totalRuns: number;
  totalTok: number;
  successRate: number;
  failure: number;
  topRun: GlobalRunRow | null;
}

function spiralCoords(n: number): Array<{ q: number; r: number }> {
  // Hex spiral coordinates (axial). center first, then concentric rings.
  if (n <= 0) return [];
  const out: Array<{ q: number; r: number }> = [{ q: 0, r: 0 }];
  let ring = 1;
  while (out.length < n) {
    let q = -ring;
    let r = ring;
    const dirs: Array<[number, number]> = [
      [1, -1],
      [1, 0],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [0, -1],
    ];
    for (const [dq, dr] of dirs) {
      for (let k = 0; k < ring; k++) {
        q += dq;
        r += dr;
        if (out.length < n) out.push({ q, r });
      }
    }
    ring += 1;
  }
  return out;
}

function axialToPixel(q: number, r: number, radius: number) {
  const x = radius * Math.sqrt(3) * (q + r / 2);
  const y = radius * 1.5 * r;
  return { x, y };
}

function hexPath(cx: number, cy: number, size: number) {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(
      `${(cx + size * Math.cos(angle)).toFixed(1)},${(cy + size * Math.sin(angle)).toFixed(1)}`,
    );
  }
  return pts.join(' ');
}

export function MissionControlV12Honeycomb() {
  const projects = useProjects();
  const summary = useRunsSummary(7);
  const globalRuns = useGlobalRuns(100);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const hexes: Hex[] = useMemo(() => {
    const projMap = new Map<string, GlobalRunRow[]>();
    (globalRuns.data ?? []).forEach((r) => {
      const arr = projMap.get(r.projectId) ?? [];
      arr.push(r);
      projMap.set(r.projectId, arr);
    });

    const list = (projects.data ?? []).map((p) => {
      const rs = projMap.get(p.id) ?? [];
      const live = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length;
      const fail = rs.filter((r) => classify(r) === 'failure').length;
      const success = rs.filter((r) => classify(r) === 'success').length;
      const closed = rs.filter((r) => ['success', 'failure', 'cancelled'].includes(classify(r)));
      const tok = rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0);
      return {
        id: p.id,
        name: p.name,
        goal: p.goal,
        rs,
        live,
        fail,
        success,
        closed: closed.length,
        tok,
      };
    });

    list.sort((a, b) => b.live - a.live || b.tok - a.tok);
    const coords = spiralCoords(list.length);
    const baseRadius = 86;
    const maxTok = Math.max(...list.map((p) => p.tok), 1);

    return list.map((p, i) => {
      const c = coords[i] ?? { q: 0, r: 0 };
      const { x, y } = axialToPixel(c.q, c.r, baseRadius);
      const sizeRatio = 0.55 + Math.sqrt(p.tok / maxTok) * 0.45;
      const size = baseRadius * 0.92 * sizeRatio;
      return {
        id: p.id,
        name: p.name,
        goal: p.goal,
        q: c.q,
        r: c.r,
        cx: x,
        cy: y,
        size,
        liveCount: p.live,
        totalRuns: p.rs.length,
        totalTok: p.tok,
        successRate: p.closed > 0 ? Math.round((p.success / p.closed) * 100) : 0,
        failure: p.fail,
        topRun:
          p.rs.find((r) => classify(r) === 'running' || classify(r) === 'paused') ??
          p.rs[0] ??
          null,
      };
    });
  }, [projects.data, globalRuns.data]);

  const selected = hexes.find((h) => h.id === selectedId) ?? null;

  // Compute viewBox bounds with margin
  const bounds = useMemo(() => {
    if (hexes.length === 0) return { vbX: -200, vbY: -200, vbW: 400, vbH: 400 };
    const xs = hexes.map((h) => h.cx);
    const ys = hexes.map((h) => h.cy);
    const sizes = hexes.map((h) => h.size);
    const m = Math.max(...sizes) + 40;
    const minX = Math.min(...xs) - m;
    const maxX = Math.max(...xs) + m;
    const minY = Math.min(...ys) - m;
    const maxY = Math.max(...ys) + m;
    return { vbX: minX, vbY: minY, vbW: maxX - minX, vbH: maxY - minY };
  }, [hexes]);

  const totalLive = hexes.reduce((s, h) => s + h.liveCount, 0);

  return (
    <div
      data-mc-variant="honeycomb"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-6 pt-4"
      style={{
        background: 'radial-gradient(ellipse at center, #f4f5fb 0%, #e9ebf2 100%)',
        color: '#1a1c2c',
      }}
    >
      <style>{`
        [data-mc-variant="honeycomb"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","ss01";
        }
        [data-mc-variant="honeycomb"] .hex-shell { transition: transform 200ms cubic-bezier(0.32,0.72,0,1); cursor: pointer; }
        [data-mc-variant="honeycomb"] .hex-shell:hover { transform: scale(1.03); }
        [data-mc-variant="honeycomb"] .hex-glow { filter: drop-shadow(0 0 14px rgba(67,56,202,0.35)); }
        @keyframes honey-pulse {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 0.8; }
        }
        [data-mc-variant="honeycomb"] .hex-pulse { animation: honey-pulse 1.8s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="honeycomb"] .hex-pulse { animation: none; }
        }
      `}</style>

      <VariantSwitcher tone="paper" set="b" />

      <header className="mb-3 flex flex-wrap items-end justify-between gap-4 border-b border-indigo-900/15 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-indigo-700">
            topology · agent-harness · service map
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Honeycomb of projects</h1>
          <div className="mt-1 max-w-prose text-[13px] text-stone-700">
            Each cell is a project. Tile size scales with token volume; fill rises with success
            rate; the cyan ring is per-project live activity.
          </div>
        </div>
        <div className="flex items-end gap-6">
          {[
            { k: 'Cells', v: String(hexes.length) },
            { k: 'Live', v: String(totalLive), tone: '#0e7490' },
            { k: 'Tokens · 7d', v: fmtTok(summary.data?.totalTokens ?? 0) },
            { k: 'OK rate', v: `${Math.round((summary.data?.successRate ?? 0) * 100)}%` },
          ].map((s) => (
            <div key={s.k} className="flex flex-col items-end leading-none">
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-stone-500">
                {s.k}
              </span>
              <span className="mt-1 text-xl font-medium tabular-nums" style={{ color: s.tone }}>
                {s.v}
              </span>
            </div>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
        <main className="relative overflow-hidden rounded-xl border border-indigo-900/10 bg-white/40 backdrop-blur-sm">
          {hexes.length === 0 ? (
            <div className="flex h-[480px] items-center justify-center text-[13px] italic text-stone-500">
              No projects on file. Create one to populate the honeycomb.
            </div>
          ) : (
            <svg
              viewBox={`${bounds.vbX} ${bounds.vbY} ${bounds.vbW} ${bounds.vbH}`}
              className="block w-full"
              style={{ minHeight: 520 }}
              role="img"
              aria-label="Project honeycomb"
            >
              <defs>
                <linearGradient id="hex-fill" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stopColor="#312e81" />
                  <stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
                <linearGradient id="hex-fill-warm" x1="0" y1="1" x2="0" y2="0">
                  <stop offset="0%" stopColor="#9a3412" />
                  <stop offset="100%" stopColor="#f97316" />
                </linearGradient>
              </defs>

              {hexes.map((h) => {
                const isSel = selectedId === h.id;
                const fillRatio = h.successRate / 100;
                const fillId =
                  h.failure > h.totalRuns / 3 && h.totalRuns > 0 ? 'hex-fill-warm' : 'hex-fill';
                return (
                  <g
                    key={h.id}
                    className={`hex-shell ${h.liveCount > 0 ? 'hex-glow' : ''}`}
                    onClick={() => setSelectedId(h.id)}
                    onMouseEnter={() => setSelectedId(h.id)}
                  >
                    {/* outer ring */}
                    <polygon
                      points={hexPath(h.cx, h.cy, h.size)}
                      fill="white"
                      stroke={isSel ? '#312e81' : 'rgba(49,46,129,0.25)'}
                      strokeWidth={isSel ? 2.5 : 1}
                    />
                    {/* fill mask using clip path */}
                    <defs>
                      <clipPath id={`clip-${h.id}`}>
                        <polygon points={hexPath(h.cx, h.cy, h.size - 4)} />
                      </clipPath>
                    </defs>
                    <rect
                      x={h.cx - h.size}
                      y={h.cy + h.size - h.size * 2 * fillRatio}
                      width={h.size * 2}
                      height={h.size * 2 * fillRatio}
                      fill={`url(#${fillId})`}
                      opacity={0.85}
                      clipPath={`url(#clip-${h.id})`}
                    />
                    {/* live ring */}
                    {h.liveCount > 0 && (
                      <polygon
                        points={hexPath(h.cx, h.cy, h.size + 4)}
                        fill="none"
                        stroke="#06b6d4"
                        strokeWidth={2}
                        className="hex-pulse"
                      />
                    )}
                    {/* label */}
                    <text
                      x={h.cx}
                      y={h.cy - h.size / 5}
                      textAnchor="middle"
                      fontSize={Math.min(15, h.size / 4.5)}
                      fontWeight={700}
                      fill="white"
                      style={{ pointerEvents: 'none', textShadow: '0 1px 4px rgba(0,0,0,0.25)' }}
                    >
                      {h.name.length > 16 ? `${h.name.slice(0, 14)}…` : h.name}
                    </text>
                    <text
                      x={h.cx}
                      y={h.cy + h.size / 4 - 4}
                      textAnchor="middle"
                      fontSize={Math.min(12, h.size / 6)}
                      fill="rgba(255,255,255,0.85)"
                      fontFamily="ui-monospace, monospace"
                      style={{ pointerEvents: 'none', letterSpacing: '0.06em' }}
                    >
                      {h.totalRuns} runs · {fmtTok(h.totalTok)}
                    </text>
                    {/* live badge */}
                    {h.liveCount > 0 && (
                      <g style={{ pointerEvents: 'none' }}>
                        <circle cx={h.cx} cy={h.cy + h.size / 2.6} r={11} fill="#06b6d4" />
                        <text
                          x={h.cx}
                          y={h.cy + h.size / 2.6 + 4}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight={700}
                          fill="white"
                        >
                          {h.liveCount}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          {/* legend overlay */}
          <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-indigo-900/15 bg-white/80 px-3 py-2 backdrop-blur">
            <div className="flex items-center gap-4 text-[10px] uppercase tracking-[0.22em] text-stone-700">
              <span className="flex items-center gap-1.5">
                <span className="block h-2 w-2 rounded-full bg-cyan-500" />
                live
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="block h-2.5 w-2.5 rounded-full"
                  style={{ background: 'linear-gradient(to top, #312e81, #6366f1)' }}
                />
                fill = success rate
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="block h-2.5 w-2.5 rounded-full"
                  style={{ background: 'linear-gradient(to top, #9a3412, #f97316)' }}
                />
                warm = failure-heavy
              </span>
              <span>size ∝ tokens</span>
            </div>
          </div>
        </main>

        <aside className="flex flex-col gap-4 lg:sticky lg:top-4">
          {selected ? (
            <div className="rounded-lg border border-indigo-900/15 bg-white px-5 py-4">
              <div className="flex items-baseline justify-between border-b border-indigo-900/10 pb-2">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">
                    cell · selected
                  </div>
                  <h2 className="mt-1 text-xl font-semibold tracking-tight">{selected.name}</h2>
                </div>
                <Link
                  to={`/projects/${selected.id}`}
                  className="rounded-full border border-stone-300 px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] hover:bg-stone-900 hover:text-white"
                >
                  open ↗
                </Link>
              </div>
              <p className="mt-3 line-clamp-3 text-[13px] text-stone-700">{selected.goal}</p>
              <dl className="mt-4 grid grid-cols-2 gap-y-2.5 text-[13px]">
                <Row k="runs · total" v={String(selected.totalRuns)} />
                <Row
                  k="live now"
                  v={String(selected.liveCount)}
                  tone={selected.liveCount > 0 ? '#0e7490' : undefined}
                />
                <Row k="tokens" v={fmtTok(selected.totalTok)} />
                <Row k="success rate" v={`${selected.successRate}%`} />
                <Row
                  k="failures"
                  v={String(selected.failure)}
                  tone={selected.failure > 0 ? '#b91c1c' : undefined}
                />
                {selected.topRun && (
                  <Row
                    k={selected.liveCount > 0 ? 'top live run' : 'most recent'}
                    v={
                      <Link
                        to={`/projects/${selected.id}/run/${selected.topRun.id}`}
                        className="hover:underline"
                      >
                        {selected.topRun.id.slice(0, 8)} · {rel(selected.topRun.startedAt)}
                      </Link>
                    }
                  />
                )}
              </dl>
              <div className="mt-4 cursor-not-allowed rounded-md border border-dashed border-stone-300 bg-stone-50 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
                    ask the team about {selected.name}
                  </span>
                  <span className="rounded-full bg-amber-100 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.18em] text-amber-800">
                    chat · soon
                  </span>
                </div>
                <div className="font-mono text-[12px] text-stone-500">
                  @qa · what's our biggest failure mode this cell?
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-indigo-900/20 bg-white/40 p-6 text-center text-[13px] italic text-stone-600">
              Hover a hex to inspect.
            </div>
          )}

          {/* Aggregate panel */}
          <div className="rounded-lg border border-indigo-900/15 bg-white p-4">
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-600">
              system pulse
            </div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {hexes.slice(0, 6).map((h) => (
                <li key={h.id} className="flex items-center gap-2 text-[12px]">
                  <span
                    className="block h-2 w-2 flex-none rounded-full"
                    style={{ background: h.liveCount > 0 ? '#06b6d4' : '#cbd5e1' }}
                  />
                  <span className="flex-1 truncate">{h.name}</span>
                  <span className="font-mono tabular-nums text-stone-500">
                    {fmtTok(h.totalTok)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <>
      <dt className="font-mono text-[10px] uppercase tracking-[0.22em] text-stone-500">{k}</dt>
      <dd className="text-right font-mono tabular-nums" style={{ color: tone ?? '#1a1c2c' }}>
        {v}
      </dd>
    </>
  );
}
