import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { edgeFade } from '../lib/anim';
import { Eyebrow } from '../components/primitives';
import { KineticText } from '../components/KineticText';

// The "complete run, start to finish" centrepiece — an animated KANBAN. The REAL
// 4-task DAG of the TipJar run (run a28afcc4) hops card-by-card across
// Pending → Running → Done in dependency order, with live token/turn counters,
// release gates, automatic retries and the final auto-merge. Every number is
// real (this run was a linear chain, so no parallelism is implied).
// Choreography is expressed as fractions of the scene duration so it always
// completes whatever length the narration sets.

const ROLE_C: Record<string, string> = {
  designer: COLORS.blue,
  'frontend-dev': COLORS.coral,
  'qa-engineer': COLORS.amber,
  'runtime-verifier': COLORS.green,
};

type T = { id: string; role: string; lane: number; run: [number, number] };
const TASKS: T[] = [
  { id: 'design-direction', role: 'designer', lane: 0, run: [0.06, 0.3] },
  { id: 'implement-crs', role: 'frontend-dev', lane: 1, run: [0.3, 0.58] },
  { id: 'verify-crs', role: 'qa-engineer', lane: 2, run: [0.58, 0.76] },
  { id: 'n-runtime-verify', role: 'runtime-verifier', lane: 3, run: [0.76, 0.9] },
];

const COLS = [
  { key: 'pending', label: 'Pending', c: COLORS.muted },
  { key: 'running', label: 'Running', c: COLORS.coral },
  { key: 'done', label: 'Done', c: COLORS.green },
] as const;

const CAPS: { t: number; label: string }[] = [
  { t: 0.14, label: 'isolated git worktrees' },
  { t: 0.5, label: 'release gates' },
  { t: 0.72, label: 'automatic retries' },
  { t: 0.9, label: 'auto-merge' },
];

const TOK_IN = 216384;
const TOK_OUT = 77529;
const TURNS = 148;
const fmtK = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v)));
const HOP = 0.02;

// Continuous column index 0..2 for a task at progress p (quick eased hops at the
// start and end of its run window).
function colIndex(p: number, [r0, r1]: [number, number]): number {
  return interpolate(p, [r0 - HOP, r0 + HOP, r1 - HOP, r1 + HOP], [0, 1, 1, 2], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
}

export const BuildStory: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;
  const fade = edgeFade(frame, dur, 14, 14);
  const p = frame / dur;

  const ramp = interpolate(p, [0.06, 0.9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const tokens = (TOK_IN + TOK_OUT) * ramp;
  const turns = Math.round(TURNS * ramp);

  const counts = [0, 0, 0];
  TASKS.forEach((t) => {
    const ci = p < t.run[0] ? 0 : p >= t.run[1] ? 2 : 1;
    counts[ci] += 1;
  });

  const gate = spring({ frame: frame - dur * 0.82, fps, config: { damping: 200 } });
  const merged = p > 0.92;
  const mergeP = spring({ frame: frame - dur * 0.92, fps, config: { damping: 16, mass: 0.7, stiffness: 130 } });

  // Board geometry.
  const W = isV ? width - 72 : 1380;
  const BH = isV ? 640 : 430;
  const colW = W / 3;
  const HEAD = 46;
  const laneTop = HEAD + 10;
  const laneH = (BH - laneTop - 8) / TASKS.length;
  const cardW = colW - (isV ? 20 : 34);
  const cardH = laneH - 12;

  return (
    <AbsoluteFill style={{ opacity: fade, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: W, display: 'flex', flexDirection: 'column', gap: isV ? 16 : 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <Eyebrow delay={6} color={COLORS.green}>
            Run · TipJar
          </Eyebrow>
          <KineticText tokens={[{ t: 'From goal to ' }, { t: 'shipped.', c: COLORS.green }]} delay={12} fontSize={isV ? 50 : 58} />
          <div style={{ display: 'flex', gap: 26, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
            {[
              ['Tokens', fmtK(tokens), COLORS.coralBright],
              ['Turns', String(turns), COLORS.fg],
              ['Agents', merged ? 'done' : `${counts[1]} live`, merged ? COLORS.green : COLORS.coral],
            ].map(([l, v, c]) => (
              <div key={l} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {l}
                </span>
                <span style={{ fontSize: 24, fontWeight: 700, color: c }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Kanban board */}
        <div
          style={{
            position: 'relative',
            width: W,
            height: BH,
            borderRadius: 22,
            background: 'rgba(20,14,9,0.72)',
            border: `1px solid ${COLORS.cardBorderBright}`,
            boxShadow: '0 40px 110px rgba(0,0,0,0.55)',
          }}
        >
          {/* column backgrounds + headers */}
          {COLS.map((col, ci) => (
            <div
              key={col.key}
              style={{
                position: 'absolute',
                left: colW * ci,
                top: 0,
                width: colW,
                height: BH,
                borderRight: ci < 2 ? `1px solid ${COLORS.cardBorder}` : undefined,
                background: `${col.c}0a`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, height: HEAD }}>
                <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: col.c }}>
                  {col.label}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: col.c,
                    background: `${col.c}22`,
                    borderRadius: 999,
                    padding: '1px 9px',
                    minWidth: 22,
                    textAlign: 'center',
                  }}
                >
                  {counts[ci]}
                </span>
              </div>
            </div>
          ))}

          {/* cards hopping across columns */}
          {TASKS.map((t, i) => {
            const reveal = spring({ frame: frame - (8 + i * 5), fps, config: { damping: 200 } });
            const ci = colIndex(p, t.run);
            const done = p >= t.run[1];
            const running = p >= t.run[0] && !done;
            const retrying = t.id === 'n-runtime-verify' && p > 0.78 && p < 0.82;
            const c = ROLE_C[t.role] ?? COLORS.coral;
            const statusC = done ? COLORS.green : running ? COLORS.coral : COLORS.muted;
            const left = colW * (0.5 + ci) - cardW / 2;
            const top = laneTop + t.lane * laneH;
            return (
              <div
                key={t.id}
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width: cardW,
                  height: cardH,
                  opacity: reveal,
                  transform: `scale(${interpolate(reveal, [0, 1], [0.9, 1])})`,
                  borderRadius: 12,
                  background: COLORS.card,
                  border: `1px solid ${running ? `${c}88` : done ? `${COLORS.green}55` : COLORS.cardBorder}`,
                  boxShadow: running ? `0 0 22px ${c}33` : '0 8px 22px rgba(0,0,0,0.35)',
                  padding: isV ? '8px 12px' : '10px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span
                    style={{
                      fontSize: isV ? 11 : 12,
                      fontWeight: 700,
                      color: c,
                      background: `${c}1c`,
                      border: `1px solid ${c}44`,
                      padding: '2px 8px',
                      borderRadius: 999,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.role}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: isV ? 11 : 12.5, fontWeight: 600, color: statusC }}>
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: statusC,
                        opacity: running ? 0.5 + 0.5 * Math.sin(frame / 4) : 1,
                      }}
                    />
                    {retrying ? 'Retry' : done ? 'Done' : running ? 'Running' : 'Queued'}
                  </span>
                </div>
                <span style={{ fontSize: isV ? 13 : 15, fontWeight: 600, color: COLORS.fg, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.id}
                </span>
              </div>
            );
          })}
        </div>

        {/* Release gate → merged */}
        <div
          style={{
            opacity: gate,
            transform: `translateY(${interpolate(gate, [0, 1], [16, 0])}px)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderRadius: 14,
            background: merged ? 'rgba(108,192,138,0.12)' : 'rgba(235,178,112,0.10)',
            border: `1px solid ${merged ? COLORS.green : COLORS.amber}55`,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 16, fontWeight: 600, color: COLORS.fg }}>
            <span style={{ color: merged ? COLORS.green : COLORS.amber, fontWeight: 700 }}>Release gate</span>
            <span style={{ color: COLORS.green }}>Boot ✓</span>
            <span style={{ color: COLORS.green }}>E2E ✓</span>
          </span>
          <span style={{ transform: `scale(${merged ? interpolate(mergeP, [0, 1], [0.8, 1]) : 0.8})`, opacity: merged ? mergeP : 0, fontSize: 16, fontWeight: 700, color: COLORS.green }}>
            Merged to main ✓
          </span>
        </div>

        {/* Capability callouts — the functions a run exercises, surfacing in order */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, justifyContent: 'center' }}>
          {CAPS.map((cap) => {
            const cp = spring({ frame: frame - dur * cap.t, fps, config: { damping: 200 } });
            return (
              <span
                key={cap.label}
                style={{
                  opacity: cp,
                  transform: `translateY(${interpolate(cp, [0, 1], [12, 0])}px) scale(${interpolate(cp, [0, 1], [0.9, 1])})`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 14px',
                  borderRadius: 999,
                  fontSize: 15,
                  fontWeight: 600,
                  color: COLORS.amber,
                  background: 'rgba(235,178,112,0.12)',
                  border: `1px solid ${COLORS.amber}33`,
                }}
              >
                <span>✓</span>
                {cap.label}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
