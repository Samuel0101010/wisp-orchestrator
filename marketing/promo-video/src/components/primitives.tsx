import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';

// Traffic-light dot for window/terminal chrome.
export const Dot: React.FC<{ c: string }> = ({ c }) => (
  <span style={{ width: 12, height: 12, borderRadius: '50%', background: c, display: 'inline-block' }} />
);

// Drifting, twinkling embers — global motion + warmth on every scene.
const Particles: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const N = 30;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {Array.from({ length: N }).map((_, i) => {
        const seed = (i * 37) % 100;
        const speed = 3 + (seed % 6);
        const size = 2 + (seed % 4);
        const x = ((i * 73) % 100) + Math.sin(t * 0.12 + i) * 1.6;
        const y = 105 - ((t * speed + ((i * 17) % 100)) % 115);
        const op = 0.1 + 0.22 * Math.abs(Math.sin(t * 0.5 + i));
        const color = i % 3 === 0 ? COLORS.amber : COLORS.coral;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: `${y}%`,
              width: size,
              height: size,
              borderRadius: '50%',
              background: color,
              opacity: op,
              boxShadow: `0 0 ${size * 3}px ${color}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

// Animated warm ground: brighter drifting coral/amber glows, warm floor,
// embers, faint masked grid.
export const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const g1x = 26 + Math.sin(t * 0.18) * 11;
  const g1y = 24 + Math.cos(t * 0.13) * 8;
  const g2x = 78 + Math.cos(t * 0.1) * 9;
  const g2y = 68 + Math.sin(t * 0.15) * 7;
  return (
    <AbsoluteFill style={{ backgroundColor: '#140E08' }}>
      <AbsoluteFill
        style={{ background: `radial-gradient(62% 62% at ${g1x}% ${g1y}%, rgba(217,121,89,0.30), transparent 68%)` }}
      />
      <AbsoluteFill
        style={{ background: `radial-gradient(60% 60% at ${g2x}% ${g2y}%, rgba(235,178,112,0.20), transparent 70%)` }}
      />
      <AbsoluteFill
        style={{ background: `radial-gradient(95% 60% at 50% 110%, rgba(217,121,89,0.18), transparent 60%)` }}
      />
      <AbsoluteFill
        style={{ background: `radial-gradient(120% 78% at 50% -10%, rgba(14,10,6,0.55), transparent 52%)` }}
      />
      <Particles />
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.024) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.024) 1px, transparent 1px)',
          backgroundSize: '76px 76px',
          WebkitMaskImage: 'radial-gradient(88% 88% at 50% 45%, black, transparent)',
          maskImage: 'radial-gradient(88% 88% at 50% 45%, black, transparent)',
        }}
      />
    </AbsoluteFill>
  );
};

// Softer cinematic vignette (lighter than before — keeps the image bright).
export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      background: 'radial-gradient(130% 130% at 50% 50%, transparent 64%, rgba(0,0,0,0.42))',
    }}
  />
);

// Thin coral playback bar growing 0→100% across the whole video.
export const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const pct = interpolate(frame, [0, durationInFrames - 1], [0, 100], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', pointerEvents: 'none' }}>
      <div style={{ height: 4, width: '100%', background: 'rgba(255,255,255,0.06)' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${COLORS.coralDeep}, ${COLORS.coral} 60%, ${COLORS.coralBright})`,
            boxShadow: `0 0 18px ${COLORS.coral}`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

// Small uppercase section label with a leading coral rule.
export const Eyebrow: React.FC<{ children: React.ReactNode; delay?: number; color?: string; fontSize?: number }> = ({
  children,
  delay = 0,
  color = COLORS.coral,
  fontSize = 22,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [12, 0])}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontSize,
        fontWeight: 600,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color,
      }}
    >
      <span style={{ width: 40, height: 2, background: color, display: 'inline-block', borderRadius: 2 }} />
      {children}
    </div>
  );
};
