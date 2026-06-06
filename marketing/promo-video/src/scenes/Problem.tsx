import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { SPRING } from '../lib/anim';
import { Eyebrow } from '../components/primitives';
import { KineticText } from '../components/KineticText';
import { Stage } from '../components/Stage';

// Dormant teammates reveal one by one across the whole scene — the team you have
// but leave idle while a single agent grinds.
const DORMANT = [
  { a: 'seed-diego.jpg', x: 16, y: 30, s: 76, d: 50 },
  { a: 'seed-lena.jpg', x: 84, y: 26, s: 70, d: 74 },
  { a: 'seed-sven.jpg', x: 12, y: 72, s: 82, d: 98 },
  { a: 'seed-priya.jpg', x: 88, y: 70, s: 72, d: 122 },
  { a: 'seed-maya.jpg', x: 78, y: 48, s: 60, d: 146 },
  { a: 'seed-noah.jpg', x: 22, y: 50, s: 60, d: 170 },
];

const Dormant: React.FC<{ a: string; x: number; y: number; s: number; d: number; i: number }> = ({
  a,
  x,
  y,
  s,
  d,
  i,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - d, fps, config: { damping: 200 } });
  const bob = Math.sin(frame / 45 + i) * 6;
  return (
    <div
      style={{
        position: 'absolute',
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%,-50%) translateY(${bob}px)`,
        opacity: p * 0.32,
      }}
    >
      <Img
        src={staticFile(`avatars/${a}`)}
        style={{
          width: s,
          height: s,
          borderRadius: '50%',
          objectFit: 'cover',
          filter: 'grayscale(1) brightness(0.7)',
          border: '2px solid rgba(255,255,255,0.08)',
        }}
      />
    </div>
  );
};

export const Problem: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const isV = height > width;

  const nodeP = spring({ frame: frame - 22, fps, config: SPRING.pop });
  const pulse = 1 + 0.035 * Math.sin(frame / 6);
  const subP = spring({ frame: frame - 150, fps, config: { damping: 200 } });

  return (
    <AbsoluteFill>
      {DORMANT.map((o, i) => (
        <Dormant key={o.a} {...o} i={i} />
      ))}
      <Stage dur={dur} push={0.055} drift={-12}>
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            padding: isV ? 80 : 120,
            flexDirection: 'column',
            gap: isV ? 44 : 50,
          }}
        >
          <Eyebrow delay={8} color={COLORS.amber}>
            The old way
          </Eyebrow>

          <div
            style={{
              position: 'relative',
              width: 150,
              height: 150,
              opacity: nodeP,
              transform: `scale(${nodeP * pulse})`,
            }}
          >
            {[0, 1].map((k) => {
              const rp = ((frame + k * 30) % 60) / 60;
              return (
                <div
                  key={k}
                  style={{
                    position: 'absolute',
                    inset: -6,
                    borderRadius: '50%',
                    border: `2px solid ${COLORS.coral}`,
                    opacity: (1 - rp) * 0.5,
                    transform: `scale(${1 + rp * 0.7})`,
                  }}
                />
              );
            })}
            <Img
              src={staticFile('avatars/seed-elena.jpg')}
              style={{
                width: 150,
                height: 150,
                borderRadius: '50%',
                objectFit: 'cover',
                border: `3px solid ${COLORS.coral}`,
                boxShadow: `0 0 48px ${COLORS.coral}55, 0 24px 60px rgba(0,0,0,0.55)`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: -12,
                left: '50%',
                transform: 'translateX(-50%)',
                padding: '4px 12px',
                borderRadius: 999,
                fontSize: 14,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                color: COLORS.coral,
                background: 'rgba(217,121,89,0.16)',
                border: `1px solid ${COLORS.coral}55`,
              }}
            >
              1 agent · busy
            </div>
          </div>

          <KineticText
            tokens={[{ t: 'One agent. One thread.' }, { t: 'One thing at a time.', c: COLORS.coral }]}
            delay={44}
            stagger={4}
            fontSize={isV ? 58 : 76}
            maxWidth={isV ? width * 0.9 : 1300}
          />

          <div
            style={{
              opacity: subP,
              transform: `translateY(${interpolate(subP, [0, 1], [10, 0])}px)`,
              fontSize: isV ? 23 : 26,
              fontWeight: 500,
              color: COLORS.muted,
              textAlign: 'center',
              maxWidth: isV ? width * 0.84 : 900,
            }}
          >
            Shipping real software takes a team, not a single chat window.
          </div>
        </AbsoluteFill>
      </Stage>
    </AbsoluteFill>
  );
};
