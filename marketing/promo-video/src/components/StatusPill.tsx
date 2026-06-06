import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';

export type Tone = 'queued' | 'running' | 'passed';

const TONES: Record<Tone, { c: string; bg: string }> = {
  queued: { c: COLORS.muted, bg: 'rgba(179,163,140,0.12)' },
  running: { c: COLORS.coral, bg: 'rgba(217,121,89,0.16)' },
  passed: { c: COLORS.green, bg: 'rgba(108,192,138,0.16)' },
};

export const StatusPill: React.FC<{ label: string; tone: Tone; delay?: number; pulse?: boolean }> = ({
  label,
  tone,
  delay = 0,
  pulse = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const s = TONES[tone];
  const dotOpacity = pulse ? 0.5 + 0.5 * Math.sin(frame / 4) : 1;
  return (
    <span
      style={{
        opacity: p,
        transform: `scale(${interpolate(p, [0, 1], [0.82, 1])})`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 13px',
        borderRadius: 999,
        fontSize: 15,
        fontWeight: 600,
        color: s.c,
        background: s.bg,
        border: `1px solid ${s.c}40`,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.c, opacity: dotOpacity }} />
      {label}
    </span>
  );
};
