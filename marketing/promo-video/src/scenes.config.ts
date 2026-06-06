// Per-scene length in frames (at 30fps). Reveals inside each scene are
// choreographed across these full durations — nothing front-loads into the
// first second. Scenes overlap by TRANSITION frames (handled by TransitionSeries
// in Promo.tsx), so the composition duration is sum(scenes) - 6 * TRANSITION.
export const SCENE_FRAMES = {
  hook: 165, // 5.5s
  problem: 205, // 6.8s
  crew: 245, // 8.2s
  plan: 250, // 8.3s
  live: 315, // 10.5s
  montage: 300, // 10.0s
  cta: 218, // 7.3s
} as const;

export const TRANSITION = 18; // overlap between adjacent scenes

const SUM = Object.values(SCENE_FRAMES).reduce((a, b) => a + b, 0); // 1698
const GAPS = Object.keys(SCENE_FRAMES).length - 1; // 6
export const TOTAL_FRAMES = SUM - GAPS * TRANSITION; // 1590 → 53s

// Background score. Swap for any real track by dropping a file into public/audio/
// and pointing this at it; null = silent. The bundled wisp-theme.wav is the
// synthesised, license-free bed from scripts/make-music.mjs.
export const MUSIC_SRC: string | null = 'audio/wisp-theme.wav';
