#!/usr/bin/env node
/**
 * Downloads AI-generated faces from thispersondoesnotexist.com into
 * apps/dashboard-web/public/avatars/.
 *
 * - 10 seed avatars (one per pre-built agent personality)
 * - 20 generic avatars for the user's custom agents
 *
 * The site rate-limits aggressively; we pace requests with a 1500ms delay.
 * Re-runs are idempotent: existing files are skipped unless --force.
 */
import { writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../apps/dashboard-web/public/avatars');
const force = process.argv.includes('--force');

const SEED_NAMES = [
  'marcus', // Manager
  'lena', // Frontend
  'diego', // Backend
  'aiko', // Mobile
  'sven', // DevOps
  'priya', // QA
  'maya', // Designer
  'elena', // ML / AI
  'javier', // Security
  'noah', // Tech Writer / Docs
];

const GENERIC_COUNT = 20;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchAvatar(targetPath) {
  if (!force && (await exists(targetPath))) {
    return { skipped: true, path: targetPath };
  }
  // thispersondoesnotexist serves a fresh AI face on each GET.
  // Use a unique cache-busting query so we never get the same image twice.
  const url = `https://thispersondoesnotexist.com/?_=${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await fetch(url, {
    headers: {
      // Some servers require a real-looking UA.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) avatar-fetch/1.0',
      Accept: 'image/jpeg,image/*',
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5000) {
    throw new Error(`Suspiciously small payload (${buf.length} bytes) — likely rate-limited.`);
  }
  await writeFile(targetPath, buf);
  return { skipped: false, path: targetPath, bytes: buf.length };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`avatars → ${OUT_DIR}`);
  const targets = [
    ...SEED_NAMES.map((n) => ({ name: `seed-${n}.jpg` })),
    ...Array.from({ length: GENERIC_COUNT }, (_, i) => ({
      name: `generic-${String(i + 1).padStart(2, '0')}.jpg`,
    })),
  ];

  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of targets) {
    const target = resolve(OUT_DIR, t.name);
    try {
      const r = await fetchAvatar(target);
      if (r.skipped) {
        skipped++;
        console.log(`  [skip] ${t.name}`);
      } else {
        done++;
        console.log(`  [ok]   ${t.name} (${(r.bytes / 1024).toFixed(0)} KB)`);
      }
    } catch (err) {
      failed++;
      console.error(`  [fail] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!targets.indexOf(t) === targets.length - 1) {
      await sleep(1500);
    } else {
      await sleep(1500);
    }
  }
  console.log(`\nDone: ${done} downloaded, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
