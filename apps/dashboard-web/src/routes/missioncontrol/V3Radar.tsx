import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const STATUS_COLOR: Record<string, string> = {
  running: '#fde68a',
  paused: '#fbbf24',
  success: '#86efac',
  failure: '#fca5a5',
  cancelled: '#a3a3a3',
  pending: '#737373',
};
function classify(r: GlobalRunRow): keyof typeof STATUS_COLOR {
  if (r.status === 'running') return 'running';
  if (r.status === 'paused') return 'paused';
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded')
    return 'failure';
  if (r.status === 'completed') return 'success';
  return 'pending';
}
function colorOf(r: GlobalRunRow): string {
  return STATUS_COLOR[classify(r)] ?? '#737373';
}

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function ageBucket(d: string | Date | null | undefined): number {
  if (!d) return 5;
  const ms = Date.now() - new Date(d as string).getTime();
  if (ms < 5 * 60_000) return 0;
  if (ms < 60 * 60_000) return 1;
  if (ms < 6 * 3_600_000) return 2;
  if (ms < 24 * 3_600_000) return 3;
  if (ms < 7 * 86_400_000) return 4;
  return 5;
}

function ageLabel(b: number): string {
  return ['<5m', '<1h', '<6h', '<1d', '<7d', '7d+'][b] ?? '7d+';
}

interface Blip {
  run: GlobalRunRow;
  ring: number;
  angle: number;
  x: number;
  y: number;
}

export function MissionControlV3Radar() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = useMemo(() => runs.data ?? [], [runs.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sweep, setSweep] = useState(0);

  useEffect(() => {
    let frame = 0;
    let raf = 0;
    const tick = () => {
      frame = (frame + 1) % 720;
      setSweep(frame * 0.5);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const cx = 320;
  const cy = 320;
  const rings = [60, 120, 190, 260, 330] as const;
  const MAX_RING = rings.at(-1) ?? 330;

  const blips: Blip[] = useMemo(() => {
    return data.map((r, i) => {
      const ring = ageBucket(r.startedAt);
      const inRing = data.filter((x) => ageBucket(x.startedAt) === ring);
      const slot = inRing.findIndex((x) => x.id === r.id);
      const angle = (slot / Math.max(inRing.length, 1)) * Math.PI * 2 - Math.PI / 2 + i * 0.00005;
      const radius = rings[Math.min(ring, rings.length - 1)] ?? MAX_RING;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius;
      return { run: r, ring, angle, x, y };
    });
  }, [data]);

  const selected = useMemo(
    () =>
      selectedId ? data.find((r) => r.id === selectedId) : data.find((r) => r.status === 'running'),
    [data, selectedId],
  );

  return (
    <div
      data-mc-variant="radar"
      className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#04060a] text-emerald-200/90 [color-scheme:dark]"
    >
      <style>{`
        [data-mc-variant="radar"] { font-family: ui-monospace, "SF Mono", "Menlo", monospace; }
        [data-mc-variant="radar"] .glow { filter: drop-shadow(0 0 4px rgba(252,211,77,0.55)); }
        [data-mc-variant="radar"] .scanline {
          background: repeating-linear-gradient(
            to bottom,
            rgba(20,255,180,0.025) 0px,
            rgba(20,255,180,0.025) 1px,
            transparent 1px,
            transparent 3px
          );
        }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="radar"] .sweep-arm { display: none; }
          [data-mc-variant="radar"] .blip-pulse { animation: none !important; }
        }
        @keyframes radar-pulse {
          0%   { r: 4; opacity: 1; }
          70%  { r: 14; opacity: 0; }
          100% { r: 14; opacity: 0; }
        }
        [data-mc-variant="radar"] .blip-pulse { animation: radar-pulse 2.4s ease-out infinite; }
      `}</style>

      <div className="px-6 pt-6">
        <VariantSwitcher tone="dark" />
      </div>

      <div className="grid grid-cols-1 gap-6 px-6 lg:grid-cols-[1fr_360px]">
        <div className="relative overflow-hidden border border-amber-200/10 bg-[#06080d]">
          <div className="scanline pointer-events-none absolute inset-0" />
          <div className="flex items-center justify-between border-b border-amber-200/10 px-4 py-2 text-[10px] uppercase tracking-[0.3em] text-emerald-300/70">
            <span>scope · agent-harness · mission control</span>
            <span className="text-amber-200/70">contacts · {data.length}</span>
          </div>

          <svg
            viewBox="0 0 640 640"
            className="block w-full"
            role="img"
            aria-label="Radar of agent runs"
          >
            <defs>
              <radialGradient id="radarGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgba(252,211,77,0.25)" />
                <stop offset="65%" stopColor="rgba(20,128,80,0.05)" />
                <stop offset="100%" stopColor="rgba(0,0,0,0)" />
              </radialGradient>
              <linearGradient id="sweep" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgba(252,211,77,0)" />
                <stop offset="98%" stopColor="rgba(252,211,77,0.45)" />
                <stop offset="100%" stopColor="rgba(252,211,77,0.85)" />
              </linearGradient>
            </defs>

            <circle cx={cx} cy={cy} r={MAX_RING + 12} fill="url(#radarGlow)" />

            {rings.map((r, i) => (
              <g key={r}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke="rgba(110,200,160,0.15)"
                  strokeWidth={0.6}
                />
                <text
                  x={cx + r}
                  y={cy - 4}
                  fill="rgba(110,200,160,0.55)"
                  fontSize={9}
                  textAnchor="end"
                  letterSpacing="0.12em"
                >
                  {ageLabel(i).toUpperCase()}
                </text>
              </g>
            ))}

            {Array.from({ length: 12 }).map((_, i) => {
              const a = (i / 12) * Math.PI * 2;
              const x2 = cx + Math.cos(a) * (MAX_RING + 6);
              const y2 = cy + Math.sin(a) * (MAX_RING + 6);
              return (
                <line
                  key={i}
                  x1={cx}
                  y1={cy}
                  x2={x2}
                  y2={y2}
                  stroke="rgba(110,200,160,0.08)"
                  strokeWidth={0.5}
                />
              );
            })}

            <g transform={`rotate(${sweep} ${cx} ${cy})`} className="sweep-arm">
              <line
                x1={cx}
                y1={cy}
                x2={cx + MAX_RING + 8}
                y2={cy}
                stroke="url(#sweep)"
                strokeWidth={2.5}
              />
              <path
                d={`M ${cx} ${cy} L ${cx + MAX_RING + 8} ${cy} A ${MAX_RING + 8} ${MAX_RING + 8} 0 0 0 ${cx + Math.cos(-0.45) * (MAX_RING + 8)} ${cy + Math.sin(-0.45) * (MAX_RING + 8)} Z`}
                fill="rgba(252,211,77,0.06)"
              />
            </g>

            {blips.map((b) => {
              const color = colorOf(b.run);
              const isLive = b.run.status === 'running' || b.run.status === 'paused';
              const isSel = selectedId === b.run.id;
              return (
                <g
                  key={b.run.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(b.run.id)}
                  onMouseEnter={() => setSelectedId(b.run.id)}
                >
                  {isLive && (
                    <circle
                      cx={b.x}
                      cy={b.y}
                      r={4}
                      fill="none"
                      stroke={color}
                      strokeWidth={1}
                      className="blip-pulse"
                    />
                  )}
                  <circle
                    cx={b.x}
                    cy={b.y}
                    r={isSel ? 4.5 : 3}
                    fill={color}
                    className={isLive ? 'glow' : ''}
                  />
                  {(isLive || isSel) && (
                    <text
                      x={b.x + 8}
                      y={b.y + 3}
                      fill="rgba(252,211,77,0.85)"
                      fontSize={10}
                      letterSpacing="0.05em"
                    >
                      {b.run.projectName.slice(0, 18)} · {b.run.id.slice(0, 6)}
                    </text>
                  )}
                </g>
              );
            })}

            <circle cx={cx} cy={cy} r={3} fill="#fcd34d" className="glow" />
          </svg>

          <div className="grid grid-cols-6 gap-3 border-t border-amber-200/10 px-4 py-3 text-[10px] uppercase tracking-[0.2em]">
            {(['running', 'paused', 'success', 'failure', 'cancelled', 'pending'] as const).map(
              (s) => (
                <div key={s} className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: STATUS_COLOR[s] }}
                  />
                  <span className="text-emerald-300/70">{s}</span>
                  <span className="ml-auto tabular-nums text-emerald-100/70">
                    {data.filter((r) => classify(r) === s).length}
                  </span>
                </div>
              ),
            )}
          </div>
        </div>

        <aside className="flex min-h-0 flex-col gap-3 border border-amber-200/10 bg-[#06080d] p-4">
          <div className="flex items-baseline justify-between border-b border-amber-200/10 pb-2 text-[10px] uppercase tracking-[0.3em] text-emerald-300/70">
            <span>contact · detail</span>
            <span className="text-amber-200/70 tabular-nums">
              {selected ? selected.id.slice(0, 8) : '——'}
            </span>
          </div>

          {selected ? (
            <div className="flex flex-col gap-3 text-[12px]">
              <div>
                <div className="text-[10px] uppercase tracking-[0.3em] text-emerald-300/60">
                  project
                </div>
                <div className="mt-1 text-base text-amber-100">{selected.projectName}</div>
              </div>
              <Row k="status" v={selected.status} tone={colorOf(selected)} />
              <Row
                k="started"
                v={
                  selected.startedAt ? new Date(selected.startedAt as string).toLocaleString() : '—'
                }
              />
              <Row
                k="ended"
                v={selected.endedAt ? new Date(selected.endedAt as string).toLocaleString() : '—'}
              />
              <Row k="tokens.in" v={fmtTok(selected.tokensInTotal)} />
              <Row k="tokens.out" v={fmtTok(selected.tokensOutTotal)} />
              <Row k="turns" v={String(selected.turnsTotal)} />
              <Row k="budget" v={`${selected.budgetMinutes}m / ${selected.budgetTurns} turns`} />
              {selected.pausedReason && <Row k="paused" v={selected.pausedReason} tone="#fbbf24" />}

              <Link
                to={`/projects/${selected.projectId}/run/${selected.id}`}
                className="mt-2 inline-flex items-center justify-between border border-amber-200/30 px-3 py-2 text-[11px] uppercase tracking-[0.25em] text-amber-200 hover:bg-amber-200/10"
              >
                Open contact
                <span>↗</span>
              </Link>
            </div>
          ) : (
            <div className="text-[12px] text-emerald-300/60">
              No contact selected. Hover a blip.
            </div>
          )}

          <div className="mt-auto border-t border-amber-200/10 pt-3 text-[10px] uppercase tracking-[0.3em] text-emerald-300/50">
            <div className="flex justify-between">
              <span>tok·7d</span>
              <span className="tabular-nums text-amber-200/80">
                {fmtTok(summary.data?.totalTokens ?? 0)}
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>ok·rate</span>
              <span className="tabular-nums text-amber-200/80">
                {Math.round((summary.data?.successRate ?? 0) * 100)}%
              </span>
            </div>
            <div className="mt-1 flex justify-between">
              <span>active</span>
              <span className="tabular-nums text-amber-200/80">
                {summary.data?.activeCount ?? 0}
              </span>
            </div>
          </div>
        </aside>
      </div>

      <footer className="mt-6 px-6 pb-6 text-[10px] uppercase tracking-[0.3em] text-emerald-300/40">
        scan · concentric arcs are age buckets · sweep is cosmetic · click or hover to lock contact
      </footer>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-amber-200/5 pb-1.5">
      <span className="text-[10px] uppercase tracking-[0.25em] text-emerald-300/60">{k}</span>
      <span className="font-mono tabular-nums" style={{ color: tone ?? 'rgba(252,211,77,0.85)' }}>
        {v}
      </span>
    </div>
  );
}
