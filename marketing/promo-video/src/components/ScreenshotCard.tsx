import React from 'react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { Dot } from './primitives';

// A dashboard screenshot framed as a browser window: chrome bar + soft shadow
// + coral edge glow, springing up into place.
export const ScreenshotCard: React.FC<{
  src: string; // filename under public/screenshots
  delay?: number;
  width?: number | string;
  rotate?: number;
  scaleFrom?: number;
  title?: string;
  animate?: boolean;
}> = ({ src, delay = 0, width = 1100, rotate = 0, scaleFrom = 0.96, title = 'localhost:4400', animate = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = animate ? spring({ frame: frame - delay, fps, config: { damping: 200 } }) : 1;
  const y = interpolate(p, [0, 1], [44, 0]);
  const scale = interpolate(p, [0, 1], [scaleFrom, 1]);
  return (
    <div
      style={{
        width,
        opacity: p,
        transform: `translateY(${y}px) rotate(${rotate}deg) scale(${scale})`,
        borderRadius: 18,
        overflow: 'hidden',
        border: `1px solid ${COLORS.cardBorder}`,
        background: COLORS.bgElevated,
        boxShadow:
          '0 50px 130px rgba(0,0,0,0.6), 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(217,121,89,0.06)',
      }}
    >
      <div
        style={{
          height: 38,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 16px',
          background: COLORS.bg,
          borderBottom: `1px solid ${COLORS.cardBorder}`,
        }}
      >
        <Dot c="#E06C5E" />
        <Dot c="#E8B25E" />
        <Dot c="#6CC08A" />
        <div
          style={{
            marginLeft: 14,
            height: 18,
            flex: 1,
            maxWidth: 320,
            borderRadius: 9,
            background: 'rgba(255,255,255,0.05)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            fontSize: 12,
            color: COLORS.faint,
          }}
        >
          {title}
        </div>
      </div>
      <Img src={staticFile(`screenshots/${src}`)} style={{ width: '100%', display: 'block' }} />
    </div>
  );
};
