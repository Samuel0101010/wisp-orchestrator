// Generates an original, license-free CINEMATIC-BUILD score for the promo (mono
// WAV). Structure follows the edit: intimate piano-arp intro → strings swell +
// bass through crew/plan → a riser into a beat DROP at the Live scene (~27s) →
// full arrangement under live/montage → piano resolution on the CTA.
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
const DUR = 53.0;
const N = Math.floor(SR * DUR);
const TAU = Math.PI * 2;

// 120 BPM. vi–IV–I–V in A minor, one chord per bar (2s) — emotional, building.
const BAR = 2.0;
const EIGHTH = 0.25;
const CHORDS = [
  [220.0, 261.63, 329.63], // Am
  [174.61, 220.0, 261.63], // F
  [196.0, 261.63, 329.63], // C
  [196.0, 246.94, 293.66], // G
];
const chordOfBar = (i) => CHORDS[(((i % 4) + 4) % 4)];
const chordAt = (t) => chordOfBar(Math.floor(t / BAR));
const ARP = [0, 1, 2, 3, 2, 3, 1, 2];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
function ramp(t, a, b, va, vb) {
  if (t <= a) return va;
  if (t >= b) return vb;
  return va + ((t - a) / (b - a)) * (vb - va);
}
// deterministic white noise (so the WAV regenerates identically)
const noise = (n) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

function piano(f, lt) {
  const env = (1 - Math.exp(-lt * 400)) * Math.exp(-lt * 6);
  const w = TAU * f * lt;
  return env * (Math.sin(w) + 0.55 * Math.sin(2 * w) + 0.28 * Math.sin(3 * w) + 0.13 * Math.sin(4 * w));
}
function arpAt(t, octave) {
  let s = 0;
  for (const so of [0, 1]) {
    const step = Math.floor(t / EIGHTH) - so;
    if (step < 0) continue;
    const lt = t - step * EIGHTH;
    const ch = chordOfBar(Math.floor((step * EIGHTH) / BAR));
    const notes = [ch[0], ch[1], ch[2], ch[0] * 2];
    s += piano(notes[ARP[((step % 8) + 8) % 8]] * octave, lt);
  }
  return s;
}

function strings(chord, t) {
  let s = 0;
  for (const f0 of chord) {
    for (const f of [f0, f0 * 1.004]) {
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(TAU * f * h * t) / h;
      s += v;
    }
  }
  return s / (chord.length * 2 * 2.4);
}
function pad(t) {
  const pos = t / BAR;
  const i = Math.floor(pos);
  const frac = pos - i;
  const xf = 0.15;
  let g = 1;
  let gn = 0;
  if (frac > 1 - xf) {
    const k = (frac - (1 - xf)) / xf;
    g = Math.cos((k * Math.PI) / 2);
    gn = Math.sin((k * Math.PI) / 2);
  }
  const trem = 1 + 0.05 * Math.sin(TAU * 0.13 * t);
  return (g * strings(chordOfBar(i), t) + gn * strings(chordOfBar(i + 1), t)) * trem;
}

function bass(t) {
  const root = chordAt(t)[0] / 2;
  const beat = 0.5;
  const lb = t % beat;
  const env = (1 - Math.exp(-lb * 200)) * Math.exp(-lb * 2.6);
  return Math.sin(TAU * root * t) * env;
}

function kick(t) {
  const lb = t % 0.5;
  const ph = TAU * (48 * lb + (80 / 45) * (1 - Math.exp(-lb * 45)));
  return Math.sin(ph) * Math.exp(-lb * 8);
}
function clap(t, n) {
  const lb = (t + 0.5) % 1.0; // hits on beats 2 & 4
  return lb > 0.12 ? 0 : noise(n) * Math.exp(-lb * 38) * 0.8;
}
function hat(t, n) {
  const step = Math.floor(t / EIGHTH);
  if (step % 2 === 0) return 0; // offbeats
  const lb = t % EIGHTH;
  return lb > 0.05 ? 0 : noise(n) * Math.exp(-lb * 130) * 0.4;
}

function riser(t, n) {
  if (t < 22 || t >= 27.02) return 0;
  const k = (t - 22) / 5;
  const amp = k * k;
  const tone = Math.sin(TAU * 220 * Math.pow(2, k * 2.2) * t) * 0.5;
  return (tone + noise(n) * 0.5) * amp;
}
function impact(t) {
  if (t < 27 || t > 28.6) return 0;
  return Math.sin(TAU * 52 * t) * Math.exp(-(t - 27) * 3.4) * 1.2;
}

const padGain = (t) =>
  t < 2 ? (t / 2) * 0.42 : t < 11 ? 0.42 : t < 27 ? ramp(t, 11, 27, 0.42, 0.95) : t < 47 ? 0.9 : ramp(t, 47, 53, 0.9, 0);
const arpGain = (t) =>
  t < 2 ? (t / 2) * 0.6 : t < 11 ? 0.6 : t < 27 ? ramp(t, 11, 27, 0.6, 0.9) : t < 47 ? 0.9 : ramp(t, 47, 53, 0.78, 0);
const bassGain = (t) => (t < 11 ? 0 : t < 27 ? ramp(t, 11, 27, 0, 0.9) : t < 47 ? 0.95 : ramp(t, 47, 49, 0.95, 0));
const drumGain = (t) => (t < 27 ? 0 : t < 29 ? ramp(t, 27, 29, 0, 1) : t < 46 ? 1 : ramp(t, 46, 47, 1, 0));

const data = Buffer.alloc(N * 2);
let peak = 0;
let sumSq = 0;
for (let n = 0; n < N; n++) {
  const t = n / SR;
  const dg = drumGain(t);
  let x =
    pad(t) * 0.7 * padGain(t) +
    arpAt(t, 1) * 0.5 * arpGain(t) +
    arpAt(t, 2) * 0.22 * dg +
    bass(t) * 0.6 * bassGain(t) +
    (kick(t) * 0.85 + clap(t, n) * 0.7 + hat(t, n) * 0.3) * dg +
    riser(t, n) * 0.5 +
    impact(t) * 0.7;
  x *= clamp01(ramp(t, 0, 1.2, 0, 1)) * clamp01(ramp(t, 52.4, 53, 1, 0)); // top & tail
  x = Math.tanh(x * 0.95) * 0.62;
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
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

writeFileSync(OUT, Buffer.concat([header, data]));
console.log(
  `wrote ${OUT}\n  ${DUR}s mono @ ${SR}Hz · ${((44 + data.length) / 1024 / 1024).toFixed(2)} MB · peak ${peak.toFixed(2)} · rms ${Math.sqrt(sumSq / N).toFixed(3)}`,
);
