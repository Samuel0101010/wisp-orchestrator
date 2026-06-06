import React from 'react';
import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { Eyebrow } from '../components/primitives';
import { ScreenshotCard } from '../components/ScreenshotCard';

type Feature = { src: string; title: string; sub: string };
const FEATURES: Feature[] = [
  { src: 'mission-control.png', title: 'Mission Control', sub: 'every run, live' },
  { src: 'chat.png', title: 'Team Chat', sub: 'brief your crew in plain language' },
  { src: 'skills.png', title: 'Skills', sub: 'audit · harden · polish, bundled in' },
  { src: 'insights.png', title: 'Insights', sub: 'outcomes, cost & trajectories' },
  { src: 'goal-planner.png', title: 'Goal Planner', sub: 'a GOAP planning sandbox' },
  { src: 'prompt-bundles.png', title: 'Prompt Bundles', sub: 'reusable context, versioned' },
];

const STEP = 48;
const SLIDE = 60;

const Label: React.FC<{ f: Feature; center?: boolean }> = ({ f, center }) => (
  <div style={{ textAlign: 'center', justifyItems: center ? 'center' : undefined }}>
    <div style={{ fontSize: 44, fontWeight: 700, color: COLORS.coral, letterSpacing: '-0.02em' }}>{f.title}</div>
    <div style={{ fontSize: 24, fontWeight: 500, color: COLORS.fg, marginTop: 6, opacity: 0.85 }}>{f.sub}</div>
  </div>
);

const FeatureSlide: React.FC<{ f: Feature; isV: boolean }> = ({ f, isV }) => {
  const frame = useCurrentFrame(); // local to this Sequence
  const { width } = useVideoConfig();
  const inP = interpolate(frame, [0, 13], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const outP = interpolate(frame, [SLIDE - 12, SLIDE], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });
  const x = interpolate(inP, [0, 1], [80, 0]) + interpolate(outP, [0, 1], [0, -64]);
  const opacity = Math.min(inP, 1 - outP);
  const kb = interpolate(frame, [0, SLIDE], [1.0, 1.05]);

  if (isV) {
    return (
      <AbsoluteFill
        style={{
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 36,
          padding: '0 50px',
          opacity,
          transform: `translateX(${x}px)`,
        }}
      >
        <div style={{ transform: `scale(${kb})` }}>
          <ScreenshotCard src={f.src} animate={false} width={width * 0.96} title={`localhost:4400 · ${f.title}`} />
        </div>
        <Label f={f} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ opacity, transform: `translateX(${x}px)` }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
          <ScreenshotCard src={f.src} animate={false} width={1560} title={`localhost:4400 · ${f.title}`} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{ pointerEvents: 'none', background: 'linear-gradient(0deg, rgba(10,7,4,0.92), transparent 26%)' }}
      />
      <div style={{ position: 'absolute', bottom: 64, left: 0, right: 0 }}>
        <Label f={f} />
      </div>
    </AbsoluteFill>
  );
};

export const Montage: React.FC<{ dur: number }> = () => {
  const { width, height } = useVideoConfig();
  const isV = height > width;

  return (
    <AbsoluteFill>
      <AbsoluteFill>
        {FEATURES.map((f, i) => (
          <Sequence key={f.src} from={i * STEP} durationInFrames={SLIDE} layout="none">
            <FeatureSlide f={f} isV={isV} />
          </Sequence>
        ))}
      </AbsoluteFill>
      <AbsoluteFill
        style={{ pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(12,9,6,0.92), transparent 20%)' }}
      />
      <div style={{ position: 'absolute', top: isV ? 70 : 56, left: 0, right: 0, display: 'flex', justifyContent: 'center' }}>
        <Eyebrow delay={6}>One dashboard for everything</Eyebrow>
      </div>
    </AbsoluteFill>
  );
};
