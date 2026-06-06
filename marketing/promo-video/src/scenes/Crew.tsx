import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';
import { Eyebrow } from '../components/primitives';
import { KineticText } from '../components/KineticText';
import { AgentCard } from '../components/AgentCard';
import { Stage } from '../components/Stage';

const AGENTS = [
  { avatar: 'seed-elena.jpg', name: 'Elena', role: 'AI Engineer' },
  { avatar: 'seed-diego.jpg', name: 'Diego', role: 'Backend Engineer' },
  { avatar: 'seed-lena.jpg', name: 'Lena', role: 'Frontend Engineer' },
  { avatar: 'seed-sven.jpg', name: 'Sven', role: 'DevOps' },
  { avatar: 'seed-priya.jpg', name: 'Priya', role: 'UX Lead' },
  { avatar: 'seed-noah.jpg', name: 'Noah', role: 'Technical Writer' },
];

export const Crew: React.FC<{ dur: number }> = ({ dur }) => {
  const { width, height } = useVideoConfig();
  const isV = height > width;

  return (
    <Stage dur={dur} push={0.05} drift={-12}>
      <AbsoluteFill
        style={{
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: isV ? 60 : 100,
          gap: isV ? 44 : 56,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
          <Eyebrow delay={8}>Step 1 — design your crew</Eyebrow>
          <KineticText
            tokens={[{ t: 'Assemble a team of' }, { t: 'specialists.', c: COLORS.coral }]}
            delay={20}
            fontSize={isV ? 58 : 78}
          />
        </div>

        <div
          style={{
            padding: isV ? 28 : '40px 44px',
            borderRadius: 28,
            background: 'rgba(36,27,18,0.45)',
            border: `1px solid ${COLORS.cardBorder}`,
            boxShadow: '0 40px 120px rgba(0,0,0,0.5)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isV ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)',
              gap: isV ? 18 : 22,
              width: isV ? width * 0.86 : 1500,
            }}
          >
            {AGENTS.map((a, i) => (
              <AgentCard key={a.name} {...a} delay={48 + i * 24} width="100%" />
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </Stage>
  );
};
