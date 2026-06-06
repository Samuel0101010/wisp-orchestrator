import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { MONO } from '../fonts';
import { SPRING } from '../lib/anim';
import { KineticText } from '../components/KineticText';
import { TerminalBlock } from '../components/TerminalBlock';
import { WordmarkSmall } from '../components/Wordmark';
import { AmbientHero } from '../components/AmbientHero';
import { Stage } from '../components/Stage';

const COMMANDS = [
  'claude plugin marketplace add Samuel0101010/wisp-orchestrator',
  'claude plugin install wisp@wisp-local',
  'claude /wisp-dashboard',
];

const META_CHIPS = ['Apache-2.0', 'v2.1.0', 'Claude Code plugin'];

export const InstallCTA: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const isV = height > width;

  const metaStart = 148;
  const urlP = spring({ frame: frame - (metaStart + 12), fps, config: { damping: 200 } });
  const ctaP = spring({ frame: frame - (metaStart + 48), fps, config: { damping: 200 } });
  const mascotP = spring({ frame: frame - (metaStart + 42), fps, config: SPRING.pop });
  const bob = Math.sin(frame / 9) * 7;

  return (
    <AbsoluteFill>
      <AmbientHero src="goal-planner.png" opacity={0.2} blur={7} />
      <Stage dur={dur} push={0.05} drift={-10}>
        <AbsoluteFill
          style={{
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            padding: isV ? 80 : 100,
            gap: isV ? 42 : 46,
          }}
        >
          <KineticText
            tokens={[{ t: 'Three commands.' }, { t: 'One dashboard.', c: COLORS.coral }]}
            delay={8}
            fontSize={isV ? 60 : 80}
          />

          <TerminalBlock
            lines={COMMANDS}
            delay={22}
            cps={28}
            width={isV ? width * 0.88 : 1120}
            fontSize={isV ? 20 : 24}
          />

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
            <WordmarkSmall delay={metaStart} width={isV ? 220 : 256} />
            <div
              style={{
                opacity: urlP,
                transform: `translateY(${interpolate(urlP, [0, 1], [8, 0])}px)`,
                fontSize: isV ? 19 : 21,
                color: COLORS.fg,
                fontFamily: MONO,
              }}
            >
              github.com/Samuel0101010/wisp-orchestrator
            </div>
            <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', justifyContent: 'center' }}>
              {META_CHIPS.map((c, i) => {
                const cp = spring({ frame: frame - (metaStart + 22 + i * 9), fps, config: { damping: 200 } });
                return (
                  <span
                    key={c}
                    style={{
                      opacity: cp,
                      transform: `translateY(${interpolate(cp, [0, 1], [8, 0])}px)`,
                      padding: '7px 15px',
                      borderRadius: 999,
                      fontSize: 15,
                      fontWeight: 600,
                      color: COLORS.muted,
                      background: 'rgba(255,255,255,0.05)',
                      border: `1px solid ${COLORS.cardBorder}`,
                    }}
                  >
                    {c}
                  </span>
                );
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 8 }}>
              <Img
                src={staticFile('wisp-mascot.png')}
                style={{
                  width: isV ? 104 : 116,
                  height: 'auto',
                  opacity: mascotP,
                  transform: `translateY(${bob}px) scale(${mascotP})`,
                  filter: 'drop-shadow(0 16px 30px rgba(0,0,0,0.5))',
                }}
              />
              <div
                style={{
                  opacity: ctaP,
                  transform: `scale(${interpolate(ctaP, [0, 1], [0.9, 1])})`,
                  padding: '16px 32px',
                  borderRadius: 999,
                  background: `linear-gradient(90deg, ${COLORS.coralDeep}, ${COLORS.coral})`,
                  color: '#1b120b',
                  fontWeight: 700,
                  fontSize: isV ? 24 : 26,
                  boxShadow: `0 20px 50px ${COLORS.coral}66`,
                }}
              >
                Get started →
              </div>
            </div>
          </div>
        </AbsoluteFill>
      </Stage>
    </AbsoluteFill>
  );
};
