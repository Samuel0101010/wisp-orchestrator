import React from 'react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { SPRING } from '../lib/anim';

// A roster card: real portrait photo + name + role, with an online dot.
export const AgentCard: React.FC<{
  avatar: string; // filename under public/avatars
  name: string;
  role: string;
  delay?: number;
  width?: number | string;
  accent?: string;
}> = ({ avatar, name, role, delay = 0, width = 340, accent = COLORS.coral }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: SPRING.pop });
  const y = interpolate(p, [0, 1], [34, 0]);
  return (
    <div
      style={{
        width,
        opacity: Math.min(1, p * 1.3),
        transform: `translateY(${y}px)`,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '18px 20px',
        borderRadius: 18,
        background: COLORS.card,
        border: `1px solid ${COLORS.cardBorder}`,
        boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
      }}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <Img
          src={staticFile(`avatars/${avatar}`)}
          style={{
            width: 62,
            height: 62,
            borderRadius: '50%',
            objectFit: 'cover',
            border: `2px solid ${accent}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: COLORS.green,
            border: `3px solid ${COLORS.card}`,
          }}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 600, color: COLORS.fg, letterSpacing: '-0.01em' }}>{name}</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: COLORS.muted, marginTop: 3 }}>{role}</div>
      </div>
    </div>
  );
};
