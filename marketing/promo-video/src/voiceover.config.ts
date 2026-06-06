// Voice-over track (Piper, English), placed in front of the music. Placement is
// derived from the timeline in scenes.config.ts (each clip is anchored to its
// scene), so it stays correct automatically when scene lengths change. The music
// ducks under every clip.
import { SCENES } from './scenes.config';

export type VoClip = { src: string; from: number; dur: number };

export const VOICEOVER: VoClip[] = SCENES.filter(
  (s): s is typeof s & { voSrc: string; voFrom: number; voDur: number } =>
    typeof s.voSrc === 'string' && typeof s.voFrom === 'number' && typeof s.voDur === 'number',
).map((s) => ({ src: s.voSrc, from: s.voFrom, dur: s.voDur }));

const MUSIC_BASE = 0.9; // music level with no voice
const MUSIC_DUCK = 0.32; // music level under the voice
const RAMP = 8; // frames to ease in/out of the duck

// Music volume at a given composition frame — ducked while any VO clip plays.
export function musicVolumeAt(frame: number): number {
  let amt = 0;
  for (const v of VOICEOVER) {
    const a = v.from;
    const b = v.from + v.dur;
    let k = 0;
    if (frame >= a - RAMP && frame < a) k = (frame - (a - RAMP)) / RAMP;
    else if (frame >= a && frame <= b) k = 1;
    else if (frame > b && frame <= b + RAMP) k = 1 - (frame - b) / RAMP;
    amt = Math.max(amt, k);
  }
  return MUSIC_BASE - amt * (MUSIC_BASE - MUSIC_DUCK);
}
