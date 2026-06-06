// Generates an original, license-free ATMOSPHERIC bg score (STEREO WAV) designed
// to sit under a voice-over: warm evolving pads + a sparse, dreamy piano motif +
// a soft sub drone — run through a real Freeverb reverb in stereo. No beat (it
// must not fight the narration). The reverb + stereo width are the quality jump
// that the earlier dry/mono synth versions lacked.
//
// Synthesised, not a recording — swap it by dropping a file into public/audio/
// and pointing MUSIC_SRC (src/scenes.config.ts) at it.
//
// Usage:  node scripts/make-music.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'audio', 'wisp-theme.wav');
mkdirSync(dirname(OUT), { recursive: true });

const SR = 44100;
const DUR = Number(process.argv[2]) || 53.0; // seconds — pass the video length
const N = Math.floor(SR * DUR);
const TAU = Math.PI * 2;

const CHORD_DUR = 4.0; // slow, evolving
const CHORDS = [
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [196.0, 261.63, 329.63], // C (G-C-E)
  [196.0, 246.94, 293.66], // G
];
const SUBS = [55.0, 43.65, 65.41, 49.0]; // A1 F1 C2 G1

// Sparse, evolving piano line (note freqs), lots of space — the reverb fills it.
// Tiled across the whole track so it works at any DUR without sounding looped:
// a gentle note sequence over an irregular gap pattern.
const P = { G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25 };
const PSEQ = ['A4', 'C5', 'E5', 'D5', 'C5', 'A4', 'G4', 'A4', 'C5', 'E5', 'D5', 'C5', 'A4', 'G4', 'E5', 'D5', 'C5', 'A4'];
const PGAPS = [2, 2, 2.5, 2.5, 3, 2.5, 3, 3];
const PIANO = [];
for (let t = 2, k = 0; t < DUR - 2.5; t += PGAPS[k % PGAPS.length], k++) {
  PIANO.push({ t0: t, f: P[PSEQ[k % PSEQ.length]] });
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
function ramp(t, a, b, va, vb) {
  if (t <= a) return va;
  if (t >= b) return vb;
  return va + ((t - a) / (b - a)) * (vb - va);
}

function padVoice(ch, t) {
  let s = 0;
  for (const f of ch) for (const d of [0.994, 1.0, 1.006]) for (let h = 1; h <= 4; h++) s += Math.sin(TAU * f * d * h * t) / (h * 1.4);
  return s / (ch.length * 3 * 2.2);
}
function pad(t) {
  const pos = t / CHORD_DUR;
  const i = Math.floor(pos);
  const frac = pos - i;
  const xf = 0.12;
  let g = 1;
  let gn = 0;
  if (frac > 1 - xf) {
    const k = (frac - (1 - xf)) / xf;
    g = Math.cos((k * Math.PI) / 2);
    gn = Math.sin((k * Math.PI) / 2);
  }
  const trem = 1 + 0.06 * Math.sin(TAU * 0.1 * t);
  return (g * padVoice(CHORDS[i % 4], t) + gn * padVoice(CHORDS[(i + 1) % 4], t)) * trem;
}
function piano(t) {
  let s = 0;
  for (const e of PIANO) {
    if (t < e.t0) break;
    const lt = t - e.t0;
    if (lt > 2.2) continue;
    const env = (1 - Math.exp(-lt * 200)) * Math.exp(-lt * 1.7);
    s += env * (Math.sin(TAU * e.f * lt) + 0.4 * Math.sin(2 * TAU * e.f * lt) + 0.12 * Math.sin(3 * TAU * e.f * lt));
  }
  return s * 0.5;
}
function sub(t) {
  const f = SUBS[Math.floor(t / CHORD_DUR) % 4];
  return Math.sin(TAU * f * t) * 0.5;
}

// --- Freeverb (mono in → stereo out) ---
const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const AP = [556, 441, 341, 225];
const SPREAD = 23;
const ROOM = 0.84;
const DAMP = 0.2;
function makeComb(size) {
  const buf = new Float32Array(size);
  let idx = 0;
  let store = 0;
  return (x) => {
    const out = buf[idx];
    store = out * (1 - DAMP) + store * DAMP;
    buf[idx] = x + store * ROOM;
    idx = idx + 1 === size ? 0 : idx + 1;
    return out;
  };
}
function makeAllpass(size) {
  const buf = new Float32Array(size);
  let idx = 0;
  return (x) => {
    const bo = buf[idx];
    const out = -x + bo;
    buf[idx] = x + bo * 0.5;
    idx = idx + 1 === size ? 0 : idx + 1;
    return out;
  };
}
const combsL = COMB.map((s) => makeComb(s));
const combsR = COMB.map((s) => makeComb(s + SPREAD));
const apsL = AP.map((s) => makeAllpass(s));
const apsR = AP.map((s) => makeAllpass(s + SPREAD));
function reverb(x) {
  const inp = x * 0.015;
  let l = 0;
  let r = 0;
  for (const c of combsL) l += c(inp);
  for (const c of combsR) r += c(inp);
  for (const a of apsL) l = a(l);
  for (const a of apsR) r = a(r);
  return [l, r];
}

const DRY = 0.62;
const WET = 0.95;
const data = Buffer.alloc(N * 2 * 2); // stereo 16-bit
let peak = 0;
let sumSq = 0;
for (let n = 0; n < N; n++) {
  const t = n / SR;
  const swell = ramp(t, 0, 18, 0.6, 1) * (t < DUR - 7 ? 1 : ramp(t, DUR - 7, DUR, 1, 0.5));
  const dryMono = (pad(t) * 0.85 + piano(t) * 0.7 + sub(t) * 0.5) * swell;
  const [wl, wr] = reverb(dryMono);
  const fade = clamp01(ramp(t, 0, 2, 0, 1)) * clamp01(ramp(t, DUR - 2, DUR, 1, 0));
  let L = (dryMono * DRY + wl * WET) * fade;
  let R = (dryMono * DRY + wr * WET) * fade;
  L = Math.tanh(L * 1.1) * 0.6;
  R = Math.tanh(R * 1.1) * 0.6;
  peak = Math.max(peak, Math.abs(L), Math.abs(R));
  sumSq += (L * L + R * R) / 2;
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L * 32767))), n * 4);
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R * 32767))), n * 4 + 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22); // stereo
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28); // byte rate
header.writeUInt16LE(4, 32); // block align
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

writeFileSync(OUT, Buffer.concat([header, data]));
console.log(
  `wrote ${OUT}\n  ${DUR}s STEREO @ ${SR}Hz · ${((44 + data.length) / 1024 / 1024).toFixed(2)} MB · peak ${peak.toFixed(2)} · rms ${Math.sqrt(sumSq / N).toFixed(3)}`,
);
