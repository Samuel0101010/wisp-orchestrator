#!/usr/bin/env node
/**
 * Copy non-TS assets into dist/ so the built server can read them at runtime.
 * tsc -b only emits .js/.d.ts; static files have to be ferried manually:
 *   - src/templates/*.json        -> dist/templates/*.json
 *   - src/skills/seed/<n>/SKILL.md -> dist/skills/seed/<n>/SKILL.md (built-in skills)
 */
import { readdirSync, mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. templates/*.json
const tplSrc = path.resolve(here, '..', 'src', 'templates');
const tplDist = path.resolve(here, '..', 'dist', 'templates');
mkdirSync(tplDist, { recursive: true });
let templates = 0;
for (const entry of readdirSync(tplSrc)) {
  if (!entry.toLowerCase().endsWith('.json')) continue;
  copyFileSync(path.join(tplSrc, entry), path.join(tplDist, entry));
  templates += 1;
}
console.log(`copied ${templates} template JSON file(s) to ${tplDist}`);

// 2. skills/seed/<skill>/SKILL.md (built-in skills shipped with the harness)
const seedSrc = path.resolve(here, '..', 'src', 'skills', 'seed');
const seedDist = path.resolve(here, '..', 'dist', 'skills', 'seed');
let seeds = 0;
if (existsSync(seedSrc)) {
  mkdirSync(seedDist, { recursive: true });
  for (const entry of readdirSync(seedSrc)) {
    const srcDir = path.join(seedSrc, entry);
    if (!statSync(srcDir).isDirectory()) continue;
    const skillFile = path.join(srcDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const dstDir = path.join(seedDist, entry);
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(skillFile, path.join(dstDir, 'SKILL.md'));
    seeds += 1;
  }
}
console.log(`copied ${seeds} seed skill(s) to ${seedDist}`);
