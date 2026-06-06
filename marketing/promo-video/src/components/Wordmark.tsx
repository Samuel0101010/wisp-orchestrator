import React from 'react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';

// The real WISP wordmark PNG, revealed with a left-to-right wipe + settle.
export const Wordmark: React.FC<{ delay?: number; width?: number }> = ({ delay = 0, width = 520 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const reveal = interpolate(p, [0, 1], [0, 100]);
  const scale = interpolate(p, [0, 1], [0.94, 1]);
  return (
    <Img
      src={staticFile('wisp-wordmark.png')}
      style={{
        width,
        height: 'auto',
        transform: `scale(${scale})`,
        clipPath: `inset(0 ${100 - reveal}% 0 0)`,
        WebkitClipPath: `inset(0 ${100 - reveal}% 0 0)`,
        filter: `drop-shadow(0 10px 34px rgba(217,121,89,0.38))`,
      }}
    />
  );
};

// Compact lockup: wordmark + a coral underline sweep. Used on the end card.
export const WordmarkSmall: React.FC<{ delay?: number; width?: number }> = ({ delay = 0, width = 230 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 12, opacity: p }}>
      <Img src={staticFile('wisp-wordmark.png')} style={{ width, height: 'auto' }} />
      <div
        style={{
          height: 3,
          width: interpolate(p, [0, 1], [0, width]),
          borderRadius: 2,
          background: `linear-gradient(90deg, transparent, ${COLORS.coral}, transparent)`,
        }}
      />
    </div>
  );
};
