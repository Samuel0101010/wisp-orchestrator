import { interpolate, Easing } from 'remotion';

// Reusable spring configs.
export const SPRING = {
  smooth: { damping: 200 }, // critically damped, no overshoot
  gentle: { damping: 26, mass: 0.9, stiffness: 90 },
  pop: { damping: 16, mass: 0.7, stiffness: 130 }, // slight, lively overshoot
} as const;

// Fade a scene in over its first `fin` frames and out over its last `fout`.
export function edgeFade(frame: number, durationInFrames: number, fin = 16, fout = 16): number {
  const fadeIn = interpolate(frame, [0, fin], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fadeOut = interpolate(frame, [durationInFrames - fout, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return Math.min(fadeIn, fadeOut);
}

// Eased 0..1 ramp between two frames.
export function ramp(
  frame: number,
  from: number,
  to: number,
  easing: (t: number) => number = Easing.out(Easing.cubic),
): number {
  return interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing,
  });
}
