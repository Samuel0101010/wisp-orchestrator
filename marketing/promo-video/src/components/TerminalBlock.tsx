import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { MONO, SANS } from '../fonts';
import { Dot } from './primitives';

// Terminal window that types out commands sequentially, character by character,
// with a blinking cursor on the active line.
export const TerminalBlock: React.FC<{
  lines: string[];
  delay?: number;
  cps?: number; // characters per second
  width?: number | string;
  fontSize?: number;
}> = ({ lines, delay = 0, cps = 30, width = 940, fontSize = 22 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = Math.max(0, frame - delay);
  const typed = (elapsed / fps) * cps;

  const total = lines.reduce((a, l) => a + l.length, 0);
  const done = typed >= total;
  const cursorOn = Math.floor(frame / 8) % 2 === 0;

  // Which line is currently being typed?
  let activeLine = lines.length - 1;
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    if (typed < acc + lines[i].length) {
      activeLine = i;
      break;
    }
    acc += lines[i].length;
  }

  let budget = typed;
  return (
    <div
      style={{
        width,
        borderRadius: 16,
        overflow: 'hidden',
        border: `1px solid ${COLORS.cardBorder}`,
        background: '#100B07',
        boxShadow: '0 50px 130px rgba(0,0,0,0.65), 0 0 0 1px rgba(217,121,89,0.07)',
      }}
    >
      <div
        style={{
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 18px',
          background: COLORS.bgElevated,
          borderBottom: `1px solid ${COLORS.cardBorder}`,
        }}
      >
        <Dot c="#E06C5E" />
        <Dot c="#E8B25E" />
        <Dot c="#6CC08A" />
        <span style={{ marginLeft: 12, fontSize: 14, color: COLORS.faint, fontFamily: SANS }}>
          claude — wisp-orchestrator
        </span>
      </div>
      <div style={{ padding: '24px 26px', fontFamily: MONO, fontSize, lineHeight: 1.85 }}>
        {lines.map((line, i) => {
          const take = Math.max(0, Math.min(line.length, Math.floor(budget)));
          budget -= line.length;
          const started = take > 0 || i < activeLine || done;
          const showCursor = (i === activeLine || (done && i === lines.length - 1)) && cursorOn;
          return (
            <div key={i} style={{ whiteSpace: 'pre', minHeight: fontSize * 1.85 }}>
              {started && <span style={{ color: COLORS.coral, fontWeight: 700 }}>{'▸ '}</span>}
              <span style={{ color: COLORS.fg }}>{line.slice(0, take)}</span>
              {showCursor && (
                <span
                  style={{
                    display: 'inline-block',
                    width: fontSize * 0.55,
                    height: fontSize * 0.95,
                    transform: 'translateY(3px)',
                    background: COLORS.coral,
                    marginLeft: 2,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
