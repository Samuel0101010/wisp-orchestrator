import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { edgeFade } from '../lib/anim';
import { Eyebrow } from '../components/primitives';
import { KineticText, type Token } from '../components/KineticText';
import { ScreenshotCard } from '../components/ScreenshotCard';

export type DesignSwapProps = {
  dur: number;
  srcA: string; // first screenshot (the "before" / desktop)
  srcB: string; // second screenshot (the "after" / mobile), cross-faded in
  labelA: string; // corner chip while A is shown
  labelB: string; // corner chip once B is shown
  eyebrow: string;
  title: Token[];
  browserTitle: string;
  accent: string;
  portrait?: boolean; // tall shots (preview-box) → narrower, height-safe card
};

// Cross-fades one screenshot into another inside a browser frame, with a corner
// chip that flips A→B. Reused for the desktop⇄mobile device switch and the
// dark⇄light redesign — both grounded in the dashboard's live preview box.
export const DesignSwap: React.FC<DesignSwapProps> = ({
  dur,
  srcA,
  srcB,
  labelA,
  labelB,
  eyebrow,
  title,
  browserTitle,
  accent,
  portrait,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const isV = height > width;
  const fade = edgeFade(frame, dur, 14, 14);
  const kb = interpolate(frame, [0, dur], [1.0, 1.05], { extrapolateRight: 'clamp' });
  const swap = interpolate(frame, [dur * 0.46, dur * 0.62], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const after = swap > 0.5;
  const cardW = portrait ? 600 : isV ? '100%' : 1180;

  const Stack = (
    <div style={{ position: 'relative', width: cardW }}>
      <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
        <ScreenshotCard src={srcA} animate={false} width="100%" title={browserTitle} />
      </div>
      <div style={{ position: 'absolute', inset: 0, opacity: swap }}>
        <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
          <ScreenshotCard src={srcB} animate={false} width="100%" title={browserTitle} />
        </div>
      </div>
      <div
        style={{
          position: 'absolute',
          top: 54,
          right: 18,
          padding: '6px 14px',
          borderRadius: 999,
          fontSize: 15,
          fontWeight: 700,
          color: COLORS.bg,
          background: accent,
          boxShadow: `0 0 18px ${accent}77`,
        }}
      >
        {after ? labelB : labelA}
      </div>
    </div>
  );

  const Header = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isV ? 'center' : 'flex-start', gap: 14 }}>
      <Eyebrow delay={6} color={accent}>
        {eyebrow}
      </Eyebrow>
      <KineticText tokens={title} delay={12} fontSize={isV ? 52 : 60} align={isV ? 'center' : 'left'} maxWidth={1300} />
    </div>
  );

  if (isV) {
    return (
      <AbsoluteFill style={{ opacity: fade, flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 40, padding: '60px 54px' }}>
        {Header}
        {Stack}
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ opacity: fade, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 60, padding: '0 90px' }}>
      <div style={{ flex: '0 0 400px' }}>{Header}</div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>{Stack}</div>
    </AbsoluteFill>
  );
};
