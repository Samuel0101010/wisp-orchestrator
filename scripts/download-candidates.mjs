#!/usr/bin/env node
/**
 * Downloads N candidate AI faces per slot into
 * apps/dashboard-web/public/avatars/_candidates/<slot>-<n>.jpg.
 *
 * Each call is cache-busted so we get fresh random faces from
 * thispersondoesnotexist.com. Used to pick gender/ethnicity-matched avatars
 * for our seed agents.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../apps/dashboard-web/public/avatars/_candidates');

// CLI: scripts/download-candidates.mjs slot1:N slot2:N ...
const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('usage: download-candidates.mjs <slot:count> ...');
  console.error('  e.g. download-candidates.mjs marcus:5 diego:5 sven:5');
  process.exit(2);
}

const targets = argv.map((a) => {
  const [slot, n] = a.split(':');
  const count = parseInt(n ?? '4', 10);
  if (!slot || !Number.isFinite(count) || count < 1) {
    throw new Error(`bad arg: ${a}`);
  }
  return { slot, count };
});

async function fetchOne(slot, idx) {
  const url = `https://thispersondoesnotexist.com/?_=${Date.now()}-${slot}-${idx}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) avatar-fetch/1.0',
      'Accept': 'image/jpeg,image/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) throw new Error(`tiny payload ${buf.length}`);
  const path = resolve(OUT_DIR, `${slot}-${String(idx).padStart(2, '0')}.jpg`);
  await writeFile(path, buf);
  return { path, bytes: buf.length };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

await mkdir(OUT_DIR, { recursive: true });
console.log(`candidates → ${OUT_DIR}`);
let total = 0;
for (const { slot, count } of targets) {
  for (let i = 1; i <= count; i++) {
    try {
      const r = await fetchOne(slot, i);
      total++;
      console.log(`  [ok] ${slot}-${String(i).padStart(2, '0')}.jpg (${(r.bytes / 1024).toFixed(0)} KB)`);
    } catch (err) {
      console.error(`  [fail] ${slot}-${i}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(1500);
  }
}
console.log(`\nDownloaded ${total} candidates total.`);
