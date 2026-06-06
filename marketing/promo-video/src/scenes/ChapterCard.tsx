import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { edgeFade } from '../lib/anim';
import { KineticText, type Token } from '../components/KineticText';

export type ChapterProps = {
  dur: number;
  index: string; // "01".."06"
  title: Token[];
  accent: string;
};

// Short act-divider beat: a big chapter number + title over a centred accent
// glow, with a rule that wipes across. Gives the long tour rhythm and breath.
export const ChapterCard: React.FC<ChapterProps> = ({ dur, index, title, accent }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isV = height > width;
  const fade = edgeFade(frame, dur, 10, 12);

  const np = spring({ frame: frame - 2, fps, config: { damping: 18, mass: 0.8, stiffness: 120 } });
  const rule = interpolate(frame, [8, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: fade, alignItems: 'center', justifyContent: 'center' }}>
      <AbsoluteFill
        style={{ background: `radial-gradient(50% 50% at 50% 50%, ${accent}22, transparent 64%)`, pointerEvents: 'none' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22, padding: '0 60px' }}>
        <div
          style={{
            opacity: np,
            transform: `translateY(${interpolate(np, [0, 1], [22, 0])}px) scale(${interpolate(np, [0, 1], [0.7, 1])})`,
            fontSize: isV ? 30 : 34,
            fontWeight: 700,
            letterSpacing: '0.42em',
            color: accent,
          }}
        >
          {index}
        </div>
        <KineticText tokens={title} delay={8} fontSize={isV ? 72 : 96} align="center" stagger={3} maxWidth={1500} />
        <div
          style={{
            width: interpolate(rule, [0, 1], [0, isV ? 240 : 340]),
            height: 3,
            borderRadius: 3,
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
            boxShadow: `0 0 16px ${accent}`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
