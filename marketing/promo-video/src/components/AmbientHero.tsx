import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';

// A large, dim, softly-blurred dashboard screenshot that fills the frame as a
// living backdrop for otherwise-sparse scenes (hook, problem, CTA). Slow
// parallax drift + a dark scrim keep foreground text readable while the product
// is always faintly present behind the message.
export const AmbientHero: React.FC<{ src: string; opacity?: number; blur?: number; scale?: number }> = ({
  src,
  opacity = 0.22,
  blur = 5,
  scale = 1.08,
}) => {
  const frame = useCurrentFrame();
  const driftX = Math.sin(frame / 150) * 1.3;
  const driftY = Math.cos(frame / 190) * 0.9;
  const z = scale + frame / 4200;
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img
        src={staticFile(`screenshots/${src}`)}
        style={{
          position: 'absolute',
          width: '120%',
          height: 'auto',
          left: '-10%',
          top: '-8%',
          transform: `translate(${driftX}%, ${driftY}%) scale(${z})`,
          filter: `blur(${blur}px) saturate(1.15) brightness(0.92)`,
          opacity,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(120% 100% at 50% 46%, rgba(20,14,8,0.5) 30%, rgba(15,11,7,0.82) 78%, rgba(12,9,6,0.93))',
        }}
      />
    </AbsoluteFill>
  );
};
