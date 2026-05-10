import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

type Glyph = { ch: string; tone: string };
const GLYPH_FALLBACK: Glyph = { ch: '·', tone: '#737373' };
const GLYPHS: Record<string, Glyph> = {
  running: { ch: '▶', tone: '#facc15' },
  paused: { ch: '⏸', tone: '#fb923c' },
  success: { ch: '◼', tone: '#34d399' },
  failure: { ch: '✕', tone: '#f87171' },
  cancelled: { ch: '⊘', tone: '#a3a3a3' },
  pending: { ch: '·', tone: '#737373' },
};
function classify(r: GlobalRunRow): keyof typeof GLYPHS {
  if (r.status === 'running') return 'running';
  if (r.status === 'paused') return 'paused';
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded')
    return 'failure';
  if (r.status === 'completed' && r.outcome === 'success') return 'success';
  if (r.status === 'completed') return 'success';
  return 'pending';
}
function glyph(r: GlobalRunRow): Glyph {
  return GLYPHS[classify(r)] ?? GLYPHS.pending ?? GLYPH_FALLBACK;
}

function relTime(d: string | Date | null | undefined) {
  if (!d) return '—';
  const t = typeof d === 'string' ? new Date(d).getTime() : (d as Date).getTime();
  const delta = Date.now() - t;
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function Sparkline({ data, w = 160, h = 24 }: { data: number[]; w?: number; h?: number }) {
  if (!data.length) return <span className="text-zinc-600">—</span>;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Tape({ runs }: { runs: GlobalRunRow[] }) {
  const live = runs.filter((r) => r.status === 'running' || r.status === 'paused');
  const items = live.length ? live : runs.slice(0, 8);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="overflow-hidden border-y border-amber-500/30 bg-black/40">
      <div
        className="flex gap-8 whitespace-nowrap py-1 text-[11px] text-amber-300/90"
        style={{
          transform: `translateX(${-((tick * 28) % 1200)}px)`,
          transition: 'transform 1s linear',
        }}
      >
        {[...items, ...items].map((r, i) => {
          const g = glyph(r);
          return (
            <span key={`${r.id}-${i}`} className="font-mono">
              <span style={{ color: g.tone }}>{g.ch}</span> {r.projectName.toUpperCase()}{' '}
              <span className="text-amber-100/60">{r.id.slice(0, 6)}</span>{' '}
              <span className="text-amber-200/80">
                IN {fmtTok(r.tokensInTotal)} · OUT {fmtTok(r.tokensOutTotal)} · T{r.turnsTotal}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function MissionControlV1Terminal() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];
  const tokenSeries = useMemo(
    () => (summary.data?.tokensByDay ?? []).map((d) => d.tokens),
    [summary.data],
  );
  const runsSeries = useMemo(
    () => (summary.data?.runsByDay ?? []).map((d) => d.runs),
    [summary.data],
  );

  const success = summary.data?.outcomeCounts.success ?? 0;
  const failure = summary.data?.outcomeCounts.failure ?? 0;
  const cancelled = summary.data?.outcomeCounts.cancelled ?? 0;

  return (
    <div
      data-mc-variant="terminal"
      className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#0a0a0b] text-amber-200 [color-scheme:dark]"
    >
      <style>{`
        [data-mc-variant="terminal"] *::selection { background: #fbbf24; color: #0a0a0b; }
        [data-mc-variant="terminal"] .grid-row:hover { background: rgba(251,191,36,0.06); }
        [data-mc-variant="terminal"] .grid-row { border-bottom: 1px solid rgba(251,191,36,0.08); }
      `}</style>

      <div className="px-6 pt-6">
        <VariantSwitcher tone="dark" />
      </div>

      <header className="grid grid-cols-12 items-end gap-6 border-b border-amber-500/30 px-6 pb-2">
        <div className="col-span-4">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-500/70">
            agent-harness // mission control
          </div>
          <div className="mt-1 font-mono text-3xl font-bold leading-none tracking-tight text-amber-100">
            MC // <span className="text-amber-400">TERMINAL</span>
          </div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-amber-500/60">
            session · localhost · 7d window · {data.length} runs in view
          </div>
        </div>
        <div className="col-span-8 flex items-end justify-end gap-10 font-mono text-[11px]">
          <Stat label="ACT" value={String(summary.data?.activeCount ?? 0)} />
          <Stat label="TOK7" value={fmtTok(summary.data?.totalTokens ?? 0)} />
          <Stat label="OK%" value={`${Math.round((summary.data?.successRate ?? 0) * 100)}`} />
          <Stat label="OK/FAIL/CXL" value={`${success}/${failure}/${cancelled}`} dim />
          <div className="flex flex-col items-end text-amber-300/80">
            <span className="text-[9px] uppercase tracking-[0.25em] text-amber-500/60">tok·d</span>
            <Sparkline data={tokenSeries} />
          </div>
          <div className="flex flex-col items-end text-amber-300/80">
            <span className="text-[9px] uppercase tracking-[0.25em] text-amber-500/60">runs·d</span>
            <Sparkline data={runsSeries} />
          </div>
        </div>
      </header>

      <Tape runs={data} />

      <section className="px-6 pt-6">
        <div className="mb-2 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.25em]">
          <span className="text-amber-500/70">// runs · sorted descending start</span>
          <span className="text-amber-500/40">
            cols: state · proj · run · pln · in · out · turns · dur · started
          </span>
        </div>
        <div className="grid grid-cols-[1.4rem_1fr_5rem_5rem_4rem_4rem_3rem_3rem_3rem] gap-x-3 border-y border-amber-500/30 bg-black/30 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-amber-500/60">
          <span>S</span>
          <span>project · id</span>
          <span className="text-right">tokIN</span>
          <span className="text-right">tokOUT</span>
          <span className="text-right">turns</span>
          <span className="text-right">budget</span>
          <span className="text-right">dur</span>
          <span className="text-right">start</span>
          <span className="text-right">→</span>
        </div>

        <ul className="font-mono text-[12px]">
          {data.length === 0 ? (
            <li className="px-3 py-6 text-amber-500/50">
              // no runs in window — kick one off from a project.
            </li>
          ) : (
            data.map((r) => {
              const g = glyph(r);
              const dur =
                r.startedAt && r.endedAt
                  ? Math.round(
                      (new Date(r.endedAt as string).getTime() -
                        new Date(r.startedAt as string).getTime()) /
                        1000,
                    )
                  : r.startedAt
                    ? Math.round((Date.now() - new Date(r.startedAt as string).getTime()) / 1000)
                    : 0;
              const durStr =
                dur < 60
                  ? `${dur}s`
                  : dur < 3600
                    ? `${Math.floor(dur / 60)}m`
                    : `${(dur / 3600).toFixed(1)}h`;
              return (
                <li
                  key={r.id}
                  className="grid-row grid grid-cols-[1.4rem_1fr_5rem_5rem_4rem_4rem_3rem_3rem_3rem] items-center gap-x-3 px-3 py-[6px]"
                >
                  <span className="text-center" style={{ color: g.tone }} title={r.status}>
                    {g.ch}
                  </span>
                  <span className="truncate text-amber-100">
                    <span className="uppercase tracking-tight">{r.projectName}</span>
                    <span className="ml-2 text-amber-400/70">{r.id.slice(0, 8)}</span>
                  </span>
                  <span className="text-right tabular-nums text-amber-200">
                    {fmtTok(r.tokensInTotal)}
                  </span>
                  <span className="text-right tabular-nums text-amber-200">
                    {fmtTok(r.tokensOutTotal)}
                  </span>
                  <span className="text-right tabular-nums text-amber-300/80">{r.turnsTotal}</span>
                  <span className="text-right tabular-nums text-amber-500/60">
                    {r.budgetMinutes}m
                  </span>
                  <span className="text-right tabular-nums text-amber-300/80">{durStr}</span>
                  <span className="text-right tabular-nums text-amber-500/60">
                    {relTime(r.startedAt)}
                  </span>
                  <span className="text-right">
                    <Link
                      to={`/projects/${r.projectId}/run/${r.id}`}
                      className="text-amber-400 hover:text-amber-200"
                    >
                      ↗
                    </Link>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <footer className="mt-10 border-t border-amber-500/20 px-6 py-3 font-mono text-[10px] uppercase tracking-[0.25em] text-amber-500/40">
        <span>
          EOF · agent-harness mission control · terminal variant · ←/→ to switch · g for grid
        </span>
      </footer>
    </div>
  );
}

function Stat({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="text-[9px] uppercase tracking-[0.25em] text-amber-500/60">{label}</span>
      <span
        className={`mt-1 text-2xl tabular-nums ${dim ? 'text-amber-400/60' : 'text-amber-100'}`}
        style={{ fontWeight: 700 }}
      >
        {value}
      </span>
    </div>
  );
}
