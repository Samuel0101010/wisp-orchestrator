import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { edgeFade } from '../lib/anim';
import { Eyebrow } from '../components/primitives';
import { KineticText, type Token } from '../components/KineticText';
import { ScreenshotCard } from '../components/ScreenshotCard';

export type TourProps = {
  dur: number;
  screenshot: string; // filename under public/screenshots
  browserTitle: string; // chrome-bar label
  eyebrow: string; // tab name
  title: Token[]; // kinetic headline
  chips: string[]; // 2-3 feature callouts
  accent: string; // chapter accent colour
  portrait?: boolean; // tall (phone/preview-box) shot → split layout, not full-bleed
};

// A row of feature chips that pop in one after another.
const Chips: React.FC<{ chips: string[]; accent: string; base: number; center?: boolean }> = ({
  chips,
  accent,
  base,
  center,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: center ? 'center' : 'flex-start' }}>
      {chips.map((c, i) => {
        const p = spring({ frame: frame - (base + i * 9), fps, config: { damping: 200 } });
        return (
          <span
            key={c}
            style={{
              opacity: p,
              transform: `translateY(${interpolate(p, [0, 1], [14, 0])}px) scale(${interpolate(p, [0, 1], [0.9, 1])})`,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 9,
              padding: '9px 16px',
              borderRadius: 999,
              fontSize: 19,
              fontWeight: 600,
              color: COLORS.fg,
              background: `${accent}1c`,
              border: `1px solid ${accent}55`,
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: accent, boxShadow: `0 0 10px ${accent}` }} />
            {c}
          </span>
        );
      })}
    </div>
  );
};

const Header: React.FC<{ eyebrow: string; title: Token[]; accent: string; fontSize: number; center?: boolean }> = ({
  eyebrow,
  title,
  accent,
  fontSize,
  center,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: center ? 'center' : 'flex-start', gap: 14 }}>
    <Eyebrow delay={6} color={accent}>
      {eyebrow}
    </Eyebrow>
    <KineticText tokens={title} delay={14} fontSize={fontSize} align={center ? 'center' : 'left'} maxWidth={1400} />
  </div>
);

export const FeatureTour: React.FC<TourProps> = ({
  dur,
  screenshot,
  browserTitle,
  eyebrow,
  title,
  chips,
  accent,
  portrait,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const isV = height > width;
  const fade = edgeFade(frame, dur, 14, 14);
  const kb = interpolate(frame, [0, dur], [1.0, 1.06], { extrapolateRight: 'clamp' });

  if (isV) {
    return (
      <AbsoluteFill style={{ opacity: fade, flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '60px 54px', gap: 40 }}>
        <Header eyebrow={eyebrow} title={title} accent={accent} fontSize={56} center />
        <div style={{ width: portrait ? '70%' : '100%', overflow: 'hidden', borderRadius: 18 }}>
          <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
            <ScreenshotCard src={screenshot} delay={8} width="100%" title={browserTitle} />
          </div>
        </div>
        <Chips chips={chips} accent={accent} base={34} center />
      </AbsoluteFill>
    );
  }

  // Landscape, tall shot → split: text column + a height-constrained screenshot.
  if (portrait) {
    return (
      <AbsoluteFill style={{ opacity: fade, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 70, padding: '0 96px' }}>
        <div style={{ flex: '0 0 560px', display: 'flex', flexDirection: 'column', gap: 30 }}>
          <Header eyebrow={eyebrow} title={title} accent={accent} fontSize={64} />
          <Chips chips={chips} accent={accent} base={30} />
        </div>
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 600, transform: `scale(${kb})`, transformOrigin: 'center' }}>
            <ScreenshotCard src={screenshot} delay={6} width="100%" title={browserTitle} />
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  // Landscape, wide shot → full-bleed screenshot with overlaid text.
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div style={{ transform: `scale(${kb})`, transformOrigin: 'center' }}>
          <ScreenshotCard src={screenshot} delay={6} width={1600} title={browserTitle} />
        </div>
      </AbsoluteFill>
      <AbsoluteFill
        style={{ pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(11,8,5,0.92) 0%, rgba(11,8,5,0.5) 14%, transparent 30%)' }}
      />
      <AbsoluteFill
        style={{ pointerEvents: 'none', background: 'linear-gradient(0deg, rgba(11,8,5,0.92) 0%, rgba(11,8,5,0.5) 14%, transparent 30%)' }}
      />
      <div style={{ position: 'absolute', top: 60, left: 84, right: 84 }}>
        <Header eyebrow={eyebrow} title={title} accent={accent} fontSize={62} />
      </div>
      <div style={{ position: 'absolute', bottom: 70, left: 84, right: 84 }}>
        <Chips chips={chips} accent={accent} base={32} />
      </div>
    </AbsoluteFill>
  );
};
