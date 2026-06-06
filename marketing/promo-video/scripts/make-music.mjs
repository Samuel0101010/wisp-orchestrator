// Generates an original, license-free ambient score for the promo (mono WAV).
// A warm pad vamp (Am–F–C–G, equal-power morphed so it never clicks) + a soft
// pulse + an intensity envelope that breathes with the edit: sparse intro,
// build through crew/plan, full under live/montage, settle on the CTA.
//
// It is SYNTHESISED, not a recording — swap it for any real track by dropping a
// file into public/audio/ and pointing MUSIC_SRC (src/scenes.config.ts) at it.
//
// Usage:  node scripts/make-music.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'audio', 'wisp-theme.wav');
mkdirSync(dirname(OUT), { recursive: true });

const SR = 44100;
const DUR = 53.0; // matches the 1590-frame / 30fps video exactly
const N = Math.floor(SR * DUR);
const TAU = Math.PI * 2;

// vi–IV–I–V in A minor, warm mid register. Smooth voice-leading.
const CHORDS = [
  [220.0, 261.63, 329.63], // Am  A3 C4 E4
  [174.61, 220.0, 261.63], // F   F3 A3 C4
  [196.0, 261.63, 329.63], // C   G3 C4 E4
  [196.0, 246.94, 293.66], // G   G3 B3 D4
];
const CHORD_DUR = 3.3;

function note(f, t) {
  const det = 0.0023; // ~4 cents of chorus
  let s = 0;
  for (const d of [1 - det, 1 + det]) {
    const w = TAU * f * d * t;
    s += Math.sin(w) + 0.35 * Math.sin(2 * w) + 0.16 * Math.sin(3 * w);
  }
  return s / 2;
}

function voice(chord, t) {
  let s = 0;
  for (const f of chord) s += note(f, t);
  s += 0.6 * Math.sin(TAU * (chord[0] / 2) * t); // sub for body
  return s / (chord.length + 0.6);
}

function pad(t) {
  const pos = t / CHORD_DUR;
  const i = Math.floor(pos);
  const frac = pos - i;
  const a = CHORDS[i % 4];
  const b = CHORDS[(i + 1) % 4];
  const wA = Math.cos((frac * Math.PI) / 2);
  const wB = Math.sin((frac * Math.PI) / 2);
  const trem = 1 + 0.08 * Math.sin(TAU * 0.15 * t);
  return (wA * voice(a, t) + wB * voice(b, t)) * trem;
}

function kick(t) {
  const beat = 60 / 86; // relaxed pulse
  const lb = t % beat;
  const phase = TAU * (45 * lb + (70 / 40) * (1 - Math.exp(-lb * 40)));
  return Math.sin(phase) * Math.exp(-lb * 9);
}

function shimmer(t) {
  const pos = t / CHORD_DUR;
  const ch = CHORDS[Math.floor(pos) % 4];
  return (Math.sin(TAU * ch[0] * 2 * t) + Math.sin(TAU * ch[2] * 2 * t)) * 0.5;
}

function ramp(t, a, b, va, vb) {
  if (t <= a) return va;
  if (t >= b) return vb;
  return va + ((t - a) / (b - a)) * (vb - va);
}

function intensity(t) {
  if (t < 2) return (t / 2) * 0.7;
  if (t < 11) return 0.6;
  if (t < 27) return ramp(t, 11, 27, 0.6, 0.85);
  if (t < 47) return 0.9;
  if (t < 51) return ramp(t, 47, 51, 0.9, 0.7);
  return Math.max(0, 0.7 * (1 - (t - 51) / 2));
}

const pulseGain = (t) => (t < 13 ? 0 : t < 16 ? (t - 13) / 3 : t < 47 ? 1 : t < 49 ? 1 - (t - 47) / 2 : 0);
const shimmerGain = (t) => (t < 27 ? 0 : t < 30 ? (t - 27) / 3 : t < 46 ? 1 : t < 48 ? 1 - (t - 46) / 2 : 0);

const data = Buffer.alloc(N * 2);
let peak = 0;
let sumSq = 0;
for (let n = 0; n < N; n++) {
  const t = n / SR;
  let x = pad(t) * 0.9 + kick(t) * pulseGain(t) * 0.5 + shimmer(t) * shimmerGain(t) * 0.25;
  x *= intensity(t);
  x = Math.tanh(x * 1.1) * 0.6; // soft clip + master gain
  peak = Math.max(peak, Math.abs(x));
  sumSq += x * x;
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32767))), n * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

writeFileSync(OUT, Buffer.concat([header, data]));
console.log(
  `wrote ${OUT}\n  ${DUR}s mono @ ${SR}Hz · ${(((44 + data.length) / 1024 / 1024) * 1).toFixed(2)} MB · peak ${peak.toFixed(2)} · rms ${Math.sqrt(sumSq / N).toFixed(3)}`,
);
