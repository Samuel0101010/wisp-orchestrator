import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';

export type Token = { t: string; c?: string };

// Headline with a per-word spring reveal (rise + fade, staggered). Pass tokens
// to colour individual phrases — e.g. [{ t: 'Run the crew' }, { t: 'live.', c: COLORS.coral }].
export const KineticText: React.FC<{
  tokens: Token[];
  delay?: number;
  fontSize?: number;
  color?: string;
  weight?: number;
  maxWidth?: number | string;
  align?: 'center' | 'left';
  stagger?: number;
  lineHeight?: number;
  letterSpacing?: string;
}> = ({
  tokens,
  delay = 0,
  fontSize = 64,
  color = COLORS.fg,
  weight = 700,
  maxWidth = 1200,
  align = 'center',
  stagger = 2.5,
  lineHeight = 1.08,
  letterSpacing = '-0.02em',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const words: { word: string; c: string }[] = [];
  tokens.forEach((tok) => {
    tok.t
      .split(' ')
      .filter(Boolean)
      .forEach((word) => words.push({ word, c: tok.c ?? color }));
  });

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0 0.28em',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        textAlign: align,
        maxWidth,
        margin: align === 'center' ? '0 auto' : undefined,
        fontSize,
        fontWeight: weight,
        lineHeight,
        letterSpacing,
      }}
    >
      {words.map((w, i) => {
        const p = spring({ frame: frame - delay - i * stagger, fps, config: { damping: 200 } });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              color: w.c,
              opacity: p,
              transform: `translateY(${interpolate(p, [0, 1], [30, 0])}px)`,
            }}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
};
