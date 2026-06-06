import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { SPRING } from '../lib/anim';
import { Wordmark } from '../components/Wordmark';
import { KineticText } from '../components/KineticText';
import { AmbientHero } from '../components/AmbientHero';
import { Stage } from '../components/Stage';

const ORBIT = [
  { a: 'seed-elena.jpg', x: 13, y: 25, d: 58, s: 88 },
  { a: 'seed-diego.jpg', x: 87, y: 31, d: 80, s: 78 },
  { a: 'seed-lena.jpg', x: 18, y: 76, d: 102, s: 74 },
  { a: 'seed-sven.jpg', x: 84, y: 72, d: 124, s: 92 },
];

const FloatAvatar: React.FC<{ a: string; x: number; y: number; d: number; s: number; i: number }> = ({
  a,
  x,
  y,
  d,
  s,
  i,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - d, fps, config: SPRING.pop });
  const bob = Math.sin(frame / 40 + i) * 9;
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) translateY(${bob}px) scale(${p})`,
        opacity: p * 0.92,
      }}
    >
      <Img
        src={staticFile(`avatars/${a}`)}
        style={{
          width: s,
          height: s,
          borderRadius: '50%',
          objectFit: 'cover',
          border: `2px solid ${COLORS.coral}88`,
          boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
        }}
      />
    </div>
  );
};

export const Hook: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const isV = height > width;
  const subP = spring({ frame: frame - 96, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill>
      <AmbientHero src="mission-control.png" opacity={0.26} blur={6} />
      <Stage dur={dur} push={0.06} drift={-14}>
        {ORBIT.map((o, i) => (
          <FloatAvatar key={o.a} {...o} i={i} />
        ))}
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: isV ? 70 : 120 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: isV ? 42 : 38 }}>
            <Wordmark delay={8} width={isV ? width * 0.78 : 620} />
            <KineticText
              tokens={[{ t: 'Orchestrate your' }, { t: 'AI agent crew.', c: COLORS.coral }]}
              delay={32}
              stagger={4}
              fontSize={isV ? 66 : 86}
              maxWidth={isV ? width * 0.9 : 1180}
            />
            <div
              style={{
                opacity: subP,
                transform: `translateY(${interpolate(subP, [0, 1], [12, 0])}px)`,
                fontSize: isV ? 23 : 27,
                fontWeight: 500,
                color: COLORS.fg,
                letterSpacing: '0.01em',
                textAlign: 'center',
                maxWidth: isV ? width * 0.84 : 940,
                textShadow: '0 2px 20px rgba(0,0,0,0.6)',
              }}
            >
              The visual orchestrator for autonomous Claude Code crews
            </div>
          </div>
        </AbsoluteFill>
      </Stage>
    </AbsoluteFill>
  );
};
