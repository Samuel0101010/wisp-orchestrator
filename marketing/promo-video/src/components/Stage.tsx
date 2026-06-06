import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';

// A continuous, scene-long camera move: a slow push-in + tiny upward drift over
// the scene's full duration. Keeps every scene alive instead of freezing after
// the entrance animations land. Wrap a scene's content in it.
export const Stage: React.FC<{ dur: number; push?: number; drift?: number; children: React.ReactNode }> = ({
  dur,
  push = 0.05,
  drift = -10,
  children,
}) => {
  const frame = useCurrentFrame();
  const p = Math.min(1, frame / dur);
  return (
    <AbsoluteFill style={{ transform: `scale(${1 + push * p}) translateY(${drift * p}px)`, transformOrigin: 'center' }}>
      {children}
    </AbsoluteFill>
  );
};
