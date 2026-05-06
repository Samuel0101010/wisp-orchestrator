#!/usr/bin/env node
/**
 * Copy src/templates/*.json into dist/templates/ so the built server can read
 * them at runtime. tsc -b only emits .js/.d.ts; static JSON has to be ferried
 * manually.
 */
import { readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src', 'templates');
const distDir = path.resolve(here, '..', 'dist', 'templates');

mkdirSync(distDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(srcDir)) {
  if (!entry.toLowerCase().endsWith('.json')) continue;
  copyFileSync(path.join(srcDir, entry), path.join(distDir, entry));
  copied += 1;
}

console.log(`copied ${copied} template JSON file(s) to ${distDir}`);
