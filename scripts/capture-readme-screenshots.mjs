// Captures dashboard screenshots for the README.
// Requires the dashboard server running on http://localhost:4400 with
// WISP_SERVE_WEB=1 (single-port mode). Outputs PNGs into
// docs/assets/screenshots/.
//
// Usage:
//   node scripts/capture-readme-screenshots.mjs
import { chromium } from '../tests/e2e/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'docs', 'assets', 'screenshots');
const BASE = 'http://localhost:4400';

const ROUTES = [
  ['mission-control', '/'],
  ['chat', '/chat'],
  ['agents', '/agents'],
  ['skills', '/skills'],
  ['workers', '/workers'],
  ['insights', '/insights'],
  ['goal-planner', '/goap'],
  ['prompt-bundles', '/prompt-bundles'],
  ['settings', '/settings'],
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  for (const [name, path] of ROUTES) {
    const url = `${BASE}${path}`;
    process.stdout.write(`-> ${name.padEnd(20)} ${url} ... `);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      const out = resolve(OUT_DIR, `${name}.png`);
      await page.screenshot({ path: out, fullPage: false });
      process.stdout.write('ok\n');
    } catch (err) {
      process.stdout.write(`FAIL ${err.message}\n`);
    }
  }

  await ctx.close();
  await browser.close();
  console.log(`\nSaved to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
