// Captures dashboard screenshots for the README.
// Requires the dashboard server running on http://localhost:4400 with
// WISP_SERVE_WEB=1 (single-port mode). Outputs PNGs into
// docs/assets/screenshots/.
//
// By default captures in LIGHT theme — set WISP_SCREENSHOT_THEME=dark to
// capture dark instead. Theme is seeded into localStorage via addInitScript
// so zustand-persist hydrates with the requested mode before any paint.
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
  const theme = (process.env.WISP_SCREENSHOT_THEME || 'light').toLowerCase();
  if (theme !== 'light' && theme !== 'dark') {
    throw new Error(`WISP_SCREENSHOT_THEME must be 'light' or 'dark', got '${theme}'`);
  }
  console.log(`theme: ${theme}`);

  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  });

  // Seed zustand-persist state BEFORE any page load so the dashboard
  // hydrates with the requested theme. addInitScript runs in every new
  // document; setItem on first navigation primes localStorage for this
  // origin so subsequent navigations in the same context inherit it too.
  const persisted = JSON.stringify({
    state: { theme, sidebarCollapsed: false, favoriteProjectIds: [] },
    version: 0,
  });
  await ctx.addInitScript(({ key, value }) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignored — about:blank pages can throw */
    }
  }, { key: 'wisp-ui', value: persisted });

  const page = await ctx.newPage();

  for (const [name, path] of ROUTES) {
    const url = `${BASE}${path}`;
    process.stdout.write(`-> ${name.padEnd(20)} ${url} ... `);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Wait for the app to apply the persisted theme to the html element
      // (App.tsx's useEffect runs after first paint).
      await page
        .waitForFunction(
          (expected) => document.documentElement.dataset.theme === expected,
          theme,
          { timeout: 5000 },
        )
        .catch(() => {});
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
