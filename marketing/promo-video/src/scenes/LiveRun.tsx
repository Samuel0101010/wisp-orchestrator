import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { Eyebrow } from '../components/primitives';
import { KineticText } from '../components/KineticText';
import { ScreenshotCard } from '../components/ScreenshotCard';
import { StatusPill, type Tone } from '../components/StatusPill';

type Task = { name: string; run: number; pass: number; reveal: number };
const TASKS: Task[] = [
  { name: 'Scaffold project', reveal: 44, run: 60, pass: 124 },
  { name: 'Build API routes', reveal: 54, run: 100, pass: 188 },
  { name: 'Implement UI', reveal: 64, run: 140, pass: 232 },
  { name: 'Run gates', reveal: 74, run: 208, pass: 274 },
];
const DONE_AT = 274;

const CHIPS = ['Isolated git worktrees', 'Real gates', 'Auto-retry'];

function resolve(frame: number, t: Task): { tone: Tone; label: string; delay: number } {
  if (frame < t.run) return { tone: 'queued', label: 'Queued', delay: t.reveal };
  if (frame < t.pass) return { tone: 'running', label: 'Running', delay: t.run };
  return { tone: 'passed', label: 'Passed', delay: t.pass };
}

const TaskRow: React.FC<{ t: Task }> = ({ t }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - t.reveal, fps, config: { damping: 200 } });
  const { tone, label, delay } = resolve(frame, t);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateX(${interpolate(p, [0, 1], [20, 0])}px)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 16px',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${COLORS.cardBorder}`,
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 500, color: COLORS.fg }}>{t.name}</span>
      <StatusPill key={tone} tone={tone} label={label} delay={delay} pulse={tone === 'running'} />
    </div>
  );
};

const LiveRunPanel: React.FC<{ width: number | string }> = ({ width }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - 34, fps, config: { damping: 200 } });
  const progress = interpolate(frame, [60, DONE_AT], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const liveDot = 0.4 + 0.6 * Math.abs(Math.sin(frame / 8));
  const done = frame > DONE_AT;
  return (
    <div
      style={{
        width,
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [30, 0])}px)`,
        padding: 26,
        borderRadius: 22,
        background: 'rgba(26,19,12,0.84)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: `1px solid ${COLORS.cardBorderBright}`,
        boxShadow: '0 50px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(217,121,89,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 22, fontWeight: 600, color: COLORS.fg }}>Run · TipJar</span>
        {done ? (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: COLORS.green }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS.green }} />
            Done ✓
          </span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, color: COLORS.coral }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS.coral, opacity: liveDot }} />
            Live
          </span>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${progress * 100}%`,
            background: done
              ? `linear-gradient(90deg, ${COLORS.green}, #8ed3a3)`
              : `linear-gradient(90deg, ${COLORS.coralDeep}, ${COLORS.coral})`,
          }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {TASKS.map((t) => (
          <TaskRow key={t.name} t={t} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 2 }}>
        {CHIPS.map((c, i) => {
          const cp = spring({ frame: frame - (282 + i * 10), fps, config: { damping: 200 } });
          return (
            <span
              key={c}
              style={{
                opacity: cp,
                transform: `scale(${interpolate(cp, [0, 1], [0.85, 1])})`,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 12px',
                borderRadius: 999,
                fontSize: 14,
                fontWeight: 600,
                color: COLORS.amber,
                background: 'rgba(235,178,112,0.12)',
                border: `1px solid ${COLORS.amber}33`,
              }}
            >
              <span>✓</span>
              {c}
            </span>
          );
        })}
      </div>
    </div>
  );
};

const Header: React.FC = () => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
    <Eyebrow delay={8}>Step 3 — watch them ship</Eyebrow>
    <KineticText
      tokens={[{ t: 'Run the crew in parallel.' }, { t: 'Live.', c: COLORS.coral }]}
      delay={20}
      fontSize={66}
    />
  </div>
);

export const LiveRun: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const isV = height > width;
  const kb = interpolate(frame, [0, dur], [1, 1.07], { extrapolateRight: 'clamp' });

  if (isV) {
    return (
      <AbsoluteFill
        style={{
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: 60,
          gap: 34,
        }}
      >
        <Header />
        <div style={{ width: '100%', overflow: 'hidden', borderRadius: 18 }}>
          <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
            <ScreenshotCard src="mission-control.png" delay={16} width="100%" title="localhost:4400 · Mission Control" />
          </div>
        </div>
        <LiveRunPanel width="100%" />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
          <ScreenshotCard src="mission-control.png" delay={10} width={1640} title="localhost:4400 · Mission Control" />
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          pointerEvents: 'none',
          background: 'linear-gradient(180deg, rgba(12,9,6,0.92) 0%, rgba(12,9,6,0.45) 16%, transparent 32%)',
        }}
      />
      <AbsoluteFill
        style={{ pointerEvents: 'none', background: 'linear-gradient(0deg, rgba(12,9,6,0.8), transparent 28%)' }}
      />
      <div style={{ position: 'absolute', top: 56, left: 0, right: 0 }}>
        <Header />
      </div>
      <div style={{ position: 'absolute', right: 70, bottom: 70, width: 520 }}>
        <LiveRunPanel width={520} />
      </div>
    </AbsoluteFill>
  );
};
