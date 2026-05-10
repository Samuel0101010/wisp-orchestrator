import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const PANEL = '#1c1d1f';
const PANEL_HI = '#2b2d31';
const PANEL_LO = '#0e0f10';
const AMBER = '#f5a524';
const GREEN = '#39d353';
const RED = '#f06262';
const STEEL = '#86888c';

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function classify(r: GlobalRunRow): 'running' | 'paused' | 'success' | 'failure' | 'cancelled' | 'pending' {
  if (r.status === 'running') return 'running';
  if (r.status === 'paused') return 'paused';
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded') return 'failure';
  if (r.status === 'completed') return 'success';
  return 'pending';
}

interface Channel {
  project: string;
  projectId: string;
  runs: GlobalRunRow[];
  liveCount: number;
  tokens: number;
  turns: number;
  successPct: number;
  topRun: GlobalRunRow | null;
  state: 'idle' | 'live' | 'fail';
}

function VuMeter({ ratio, color }: { ratio: number; color: string }) {
  // 12 segments, log scale
  const segs = 12;
  const lit = Math.round(Math.min(1, ratio) * segs);
  return (
    <div className="flex h-3 items-center gap-[2px] rounded-[2px] border border-black/60 bg-black/70 p-[2px]">
      {Array.from({ length: segs }).map((_, i) => {
        const isLit = i < lit;
        const tone =
          i < segs * 0.6 ? color : i < segs * 0.85 ? AMBER : RED;
        return (
          <div
            key={i}
            className="flex-1"
            style={{
              height: '100%',
              background: isLit ? tone : 'transparent',
              boxShadow: isLit ? `0 0 4px ${tone}` : 'none',
              opacity: isLit ? 1 : 0.18,
              transition: 'opacity 80ms',
            }}
          />
        );
      })}
    </div>
  );
}

function LedDisplay({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-[3px]">
      <div className="text-[7px] uppercase tracking-[0.28em] text-stone-400">{label}</div>
      <div
        className={`flex h-7 min-w-[64px] items-center justify-center rounded-[2px] border border-black/60 px-2 ${mono ? 'font-mono' : ''}`}
        style={{
          background: '#0a0b0c',
          color: AMBER,
          textShadow: `0 0 6px ${AMBER}`,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 2px rgba(0,0,0,0.6)',
          fontSize: 13,
          letterSpacing: '0.04em',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Knob({ label, valueDeg }: { label: string; valueDeg: number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="relative h-9 w-9 rounded-full"
        style={{
          background: 'radial-gradient(circle at 30% 25%, #4a4d52, #1d1e20 70%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.7)',
        }}
      >
        <div
          className="absolute left-1/2 top-1 h-3 w-[2px] -translate-x-1/2"
          style={{
            background: AMBER,
            transformOrigin: '50% 14px',
            transform: `translateX(-50%) rotate(${valueDeg}deg)`,
            boxShadow: `0 0 4px ${AMBER}`,
          }}
        />
      </div>
      <div className="text-[7px] uppercase tracking-[0.25em] text-stone-400">{label}</div>
    </div>
  );
}

function StatusLed({ state }: { state: Channel['state'] }) {
  const color = state === 'live' ? GREEN : state === 'fail' ? RED : '#3a3a3a';
  const blink = state === 'live';
  return (
    <div className="flex items-center gap-1">
      <span
        className="h-2 w-2 rounded-full"
        style={{
          background: color,
          boxShadow: state === 'idle' ? 'inset 0 0 1px black' : `0 0 6px ${color}`,
          animation: blink ? 'led-blink 1.6s ease-in-out infinite' : 'none',
        }}
      />
      <span className="text-[7px] uppercase tracking-[0.25em] text-stone-400">
        {state === 'live' ? 'live' : state === 'fail' ? 'fault' : 'standby'}
      </span>
    </div>
  );
}

function ChannelStrip({ ch }: { ch: Channel }) {
  const liveTok = ch.topRun ? ch.topRun.tokensInTotal + ch.topRun.tokensOutTotal : 0;
  const ratio = liveTok > 0 ? Math.log10(1 + liveTok) / 6 : 0;
  return (
    <div
      className="flex w-[148px] flex-none flex-col items-stretch gap-3 border-l border-r p-3"
      style={{
        background: `linear-gradient(180deg, ${PANEL_HI}, ${PANEL} 30%, ${PANEL_LO})`,
        borderLeftColor: 'rgba(255,255,255,0.04)',
        borderRightColor: 'rgba(0,0,0,0.6)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex flex-col items-center gap-1">
        <div className="text-[9px] uppercase tracking-[0.22em] text-stone-300 max-w-full truncate">
          {ch.project}
        </div>
        <StatusLed state={ch.state} />
      </div>

      <LedDisplay value={String(ch.runs.length).padStart(3, '0')} label="runs" />

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-[7px] uppercase tracking-[0.25em] text-stone-400">
          <span>tok level</span>
          <span className="font-mono text-amber-300/80" style={{ color: AMBER }}>
            {fmtTok(ch.tokens)}
          </span>
        </div>
        <VuMeter ratio={ratio || ch.tokens / 5_000_000} color={GREEN} />
      </div>

      <div className="flex items-end justify-between gap-1">
        <Knob label="bgt" valueDeg={-110 + ch.successPct * 2.2} />
        <Knob label="par" valueDeg={-90 + Math.min(180, ch.turns * 4)} />
      </div>

      <LedDisplay value={String(ch.turns)} label="turns" />

      <div className="flex flex-col items-center gap-1">
        <div className="h-px w-full" style={{ background: 'rgba(255,255,255,0.05)' }} />
        <div className="text-[7px] uppercase tracking-[0.25em] text-stone-400">ok rate</div>
        <div
          className="font-mono text-[14px] tabular-nums"
          style={{ color: ch.successPct >= 80 ? GREEN : ch.successPct >= 50 ? AMBER : RED }}
        >
          {ch.successPct}%
        </div>
      </div>

      {ch.topRun ? (
        <Link
          to={`/projects/${ch.projectId}/run/${ch.topRun.id}`}
          className="mt-auto block rounded-[2px] border border-black/60 bg-stone-900 px-2 py-1 text-center text-[9px] uppercase tracking-[0.22em] text-amber-300 hover:bg-stone-800"
          style={{ color: AMBER }}
        >
          patch ↗
        </Link>
      ) : (
        <div className="mt-auto rounded-[2px] border border-black/60 bg-stone-900/60 px-2 py-1 text-center text-[9px] uppercase tracking-[0.22em] text-stone-500">
          no patch
        </div>
      )}
    </div>
  );
}

function MasterSection({
  active,
  totalTok,
  successPct,
  totalRuns,
}: {
  active: number;
  totalTok: number;
  successPct: number;
  totalRuns: number;
}) {
  const arcCircumference = 2 * Math.PI * 38;
  const dash = (successPct / 100) * arcCircumference;
  return (
    <div
      className="flex w-[280px] flex-none flex-col gap-4 border-l p-4"
      style={{
        background: `linear-gradient(180deg, ${PANEL_HI}, ${PANEL} 40%, ${PANEL_LO})`,
        borderLeftColor: 'rgba(0,0,0,0.7)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), inset 2px 0 0 rgba(255,255,255,0.04)',
      }}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-300" style={{ color: AMBER }}>
          MASTER
        </span>
        <span className="text-[9px] uppercase tracking-[0.25em] text-stone-400">7d window</span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <LedDisplay value={String(active).padStart(2, '0')} label="active" />
        <LedDisplay value={fmtTok(totalTok)} label="tok 7d" />
      </div>

      <div className="flex items-center justify-center py-2">
        <svg width={120} height={120} viewBox="0 0 120 120">
          <circle cx={60} cy={60} r={38} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={6} />
          <circle
            cx={60}
            cy={60}
            r={38}
            fill="none"
            stroke={AMBER}
            strokeWidth={6}
            strokeDasharray={`${dash} ${arcCircumference - dash}`}
            strokeDashoffset={arcCircumference / 4}
            transform="rotate(-90 60 60)"
            style={{ filter: `drop-shadow(0 0 4px ${AMBER})` }}
          />
          <text
            x={60}
            y={62}
            textAnchor="middle"
            fontSize={26}
            fontWeight={700}
            fill={AMBER}
            style={{ fontFamily: 'ui-monospace,monospace', textShadow: `0 0 6px ${AMBER}` }}
          >
            {successPct}%
          </text>
          <text
            x={60}
            y={82}
            textAnchor="middle"
            fontSize={8}
            fill="#aaa"
            style={{ letterSpacing: '0.25em', textTransform: 'uppercase' }}
          >
            ok rate
          </text>
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <LedDisplay value={String(totalRuns).padStart(3, '0')} label="runs" />
        <LedDisplay value={fmtTok(totalTok / Math.max(totalRuns, 1))} label="tok/run" mono />
      </div>

      <div className="mt-auto flex items-center justify-between rounded-[2px] border border-black/60 bg-black/60 px-3 py-2">
        <span className="text-[8px] uppercase tracking-[0.3em] text-stone-400">power</span>
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }}
        />
        <span className="text-[10px] tracking-[0.18em] text-stone-300">on air</span>
      </div>
    </div>
  );
}

export function MissionControlV8Console() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];

  const channels: Channel[] = useMemo(() => {
    const map = new Map<string, GlobalRunRow[]>();
    data.forEach((r) => {
      const arr = map.get(r.projectName) ?? [];
      arr.push(r);
      map.set(r.projectName, arr);
    });
    return Array.from(map.entries())
      .map(([project, rs]) => {
        const liveCount = rs.filter((r) => classify(r) === 'running' || classify(r) === 'paused').length;
        const failCount = rs.filter((r) => classify(r) === 'failure').length;
        const success = rs.filter((r) => classify(r) === 'success').length;
        const closed = rs.filter((r) => ['success', 'failure', 'cancelled'].includes(classify(r))).length;
        const tokens = rs.reduce((s, r) => s + r.tokensInTotal + r.tokensOutTotal, 0);
        const turns = rs.reduce((s, r) => s + r.turnsTotal, 0);
        const topRun =
          rs.find((r) => classify(r) === 'running' || classify(r) === 'paused') ?? rs[0] ?? null;
        const state: Channel['state'] =
          liveCount > 0 ? 'live' : failCount > success && closed > 0 ? 'fail' : 'idle';
        return {
          project,
          projectId: rs[0]?.projectId ?? '',
          runs: rs,
          liveCount,
          tokens,
          turns,
          successPct: closed > 0 ? Math.round((success / closed) * 100) : 0,
          topRun,
          state,
        };
      })
      .sort((a, b) => b.tokens - a.tokens);
  }, [data]);

  return (
    <div
      data-mc-variant="console"
      className="-m-6 min-h-[calc(100vh-3.5rem)] [color-scheme:dark]"
      style={{
        background:
          'radial-gradient(ellipse at top, #2a2c30 0%, #161719 55%, #0c0d0e 100%)',
        color: '#cfcfd1',
      }}
    >
      <style>{`
        @keyframes led-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        @media (prefers-reduced-motion: reduce) {
          [data-mc-variant="console"] [style*="led-blink"] { animation: none !important; }
        }
        [data-mc-variant="console"] {
          font-family: ui-sans-serif, "Inter", system-ui, sans-serif;
          font-feature-settings: "tnum","zero";
        }
      `}</style>

      <div className="px-6 pt-6">
        <VariantSwitcher tone="dark" />
      </div>

      <header
        className="mx-6 flex items-end justify-between border-b-2 px-6 py-3"
        style={{
          background: 'linear-gradient(180deg, #2c2e32, #1a1b1d)',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          borderLeftColor: 'rgba(255,255,255,0.05)',
          borderRightColor: 'rgba(0,0,0,0.7)',
          borderBottomColor: 'rgba(0,0,0,0.7)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <div>
          <div
            className="font-mono text-[10px] uppercase tracking-[0.35em]"
            style={{ color: AMBER }}
          >
            harness · mission control · console
          </div>
          <h1 className="text-[28px] font-bold tracking-tight text-stone-100">
            On-air board · {channels.length} channels
          </h1>
        </div>
        <div className="flex items-center gap-4 text-[10px] uppercase tracking-[0.25em] text-stone-400">
          <span style={{ color: AMBER }}>● rec</span>
          <span>monitor · pgm</span>
          <span className="font-mono">{new Date().toLocaleTimeString('en-GB')}</span>
        </div>
      </header>

      <main className="mx-6 mb-6 mt-3 flex overflow-x-auto rounded-[3px] border-l border-r border-b" style={{
        borderLeftColor: 'rgba(255,255,255,0.05)',
        borderRightColor: 'rgba(0,0,0,0.7)',
        borderBottomColor: 'rgba(0,0,0,0.7)',
        background: '#16171a',
        boxShadow: 'inset 0 -2px 0 rgba(0,0,0,0.6)',
      }}>
        {channels.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6 py-16 text-stone-500">
            <span className="font-mono text-[11px] uppercase tracking-[0.25em]">
              no channels patched · awaiting input
            </span>
          </div>
        ) : (
          channels.map((c) => <ChannelStrip key={c.project} ch={c} />)
        )}

        <MasterSection
          active={summary.data?.activeCount ?? 0}
          totalTok={summary.data?.totalTokens ?? 0}
          successPct={Math.round((summary.data?.successRate ?? 0) * 100)}
          totalRuns={summary.data?.totalRuns ?? 0}
        />
      </main>

      <footer className="mx-6 mb-6 flex items-baseline justify-between text-[10px] uppercase tracking-[0.3em] text-stone-500">
        <span>+4 dBu nominal · 24-bit · −18 dBFS reference · agent-harness studio</span>
        <span className="font-mono">v8 · console</span>
      </footer>
    </div>
  );
}
