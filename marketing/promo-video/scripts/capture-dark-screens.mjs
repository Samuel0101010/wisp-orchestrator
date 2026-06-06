// Captures the WISP dashboard in DARK theme for the promo video.
// Requires the dashboard server running on http://localhost:4400 with
// WISP_SERVE_WEB=1 (single-port mode). Boot it with WISP_MOCK_CLI=1 so the
// auth probe is skipped and the AuthBanner stays hidden in every shot.
//
// Output: marketing/promo-video/public/screenshots/*.png  (does NOT touch the
// committed README screenshots under docs/assets/screenshots).
//
// Usage:  node scripts/capture-dark-screens.mjs
import { chromium } from '../../../tests/e2e/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'screenshots');
const BASE = process.env.WISP_DASHBOARD ?? 'http://localhost:4400';
const theme = 'dark';

// TipJar — the richest seeded project: locked plan with a real DAG + a
// successful 148-turn run. Used for the project-scoped sub-routes so the
// Plan Editor shows a real graph and the Run View shows a full pipeline.
const PROJECT = '65bd5151-4b8a-42ad-ba74-88c295bb7fe2';
const RUN = 'a28afcc4-4c54-4407-b2bc-161bf2f9ec94';

const ROUTES = [
  ['mission-control', '/'],
  ['focusboard', `/focus/${PROJECT}`],
  ['chat', '/chat'],
  ['agents', '/agents'],
  ['project-detail', `/projects/${PROJECT}`],
  ['team-builder', `/projects/${PROJECT}/teams`],
  ['plan-editor', `/projects/${PROJECT}/plan`],
  ['run-view', `/projects/${PROJECT}/run/${RUN}`],
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
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  });

  // Seed zustand-persist state so the dashboard hydrates in dark mode before
  // first paint (addInitScript runs in every new document for this origin).
  const persisted = JSON.stringify({
    state: { theme, sidebarCollapsed: false, favoriteProjectIds: [] },
    version: 0,
  });
  await ctx.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* about:blank can throw */
      }
    },
    { key: 'wisp-ui', value: persisted },
  );

  const page = await ctx.newPage();

  for (const [name, path] of ROUTES) {
    const url = `${BASE}${path}`;
    process.stdout.write(`-> ${name.padEnd(18)} ${url} ... `);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page
        .waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme, {
          timeout: 5000,
        })
        .catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      // React Flow (Plan Editor) + the Run-View Kanban + charts need a beat to
      // lay out and finish their entry animation before the shot.
      await page.waitForTimeout(1600);
      await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), fullPage: false });
      process.stdout.write('ok\n');
    } catch (err) {
      process.stdout.write(`FAIL ${err.message}\n`);
    }
  }

  await ctx.close();
  await browser.close();
  console.log(`\nSaved dark screenshots to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
