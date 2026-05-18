/**
 * One-shot screenshot capture for the README — runs against the dashboard
 * already booted on http://localhost:4400 and the FocusBoard demo at
 * http://localhost:4174. Captures three screenshots into
 * `docs/assets/screenshots/`:
 *
 *   - preview.png        — the Vorschau tab with FocusBoard rendering in the
 *                          proxied iframe (the v2.0 money shot).
 *   - goal-planner.png   — the Goal-Planer tab post-v2.0.8.
 *   - mission-control.png — the Mission Control overview.
 *
 * Light theme. Requires:
 *   pnpm exec playwright install chromium
 *
 * Run with:
 *   node scripts/capture-screenshots.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Use the playwright runtime that's pulled in via @playwright/test in the
// workspace devDependencies. Resolved by absolute path because the script
// lives at the repo root (not in a workspace package).
const require = createRequire(import.meta.url);
const playwrightPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.pnpm',
  'playwright@1.59.1',
  'node_modules',
  'playwright',
);
const { chromium } = require(playwrightPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '..', 'docs', 'assets', 'screenshots');
const DASHBOARD = process.env.WISP_DASHBOARD ?? 'http://localhost:4400';
const PROJECT_ID = process.env.FOCUSBOARD_PROJECT_ID ?? '201f28b4-8495-4b5c-b08d-97c96981faff';
const VIEWPORT = { width: 1600, height: 1000 };

async function ensureLightTheme(page) {
  // Force light theme via the zustand-persist store so the dashboard boots
  // into light mode. The store key is `wisp-ui` and shape is the standard
  // zustand persist envelope.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'wisp-ui',
        JSON.stringify({
          state: { theme: 'light', sidebarCollapsed: false, favoriteProjectIds: [] },
          version: 0,
        }),
      );
      document.documentElement.classList.remove('dark');
      document.documentElement.classList.add('light');
      document.documentElement.dataset.theme = 'light';
    } catch {
      /* ignore */
    }
  });
}

async function captureMissionControl(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await ensureLightTheme(page);
  await page.goto(DASHBOARD + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const out = path.join(outDir, 'mission-control.png');
  await page.screenshot({ path: out, fullPage: false });
  console.log('wrote', out);
  await ctx.close();
}

async function captureGoalPlanner(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await ensureLightTheme(page);
  await page.goto(DASHBOARD + '/goap', { waitUntil: 'networkidle' });
  // Trigger the plan so the canvas shows a computed plan rather than the
  // empty preview state — that's the more compelling screenshot.
  await page.waitForTimeout(500);
  const planBtn = page.getByRole('button', { name: /Plan erstellen|Run plan/i });
  if (await planBtn.isVisible().catch(() => false)) {
    await planBtn.click();
    await page.waitForTimeout(900);
  }
  const out = path.join(outDir, 'goal-planner.png');
  await page.screenshot({ path: out, fullPage: false });
  console.log('wrote', out);
  await ctx.close();
}

async function capturePreview(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await ensureLightTheme(page);
  await page.goto(DASHBOARD + `/projects/${PROJECT_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  // Click the Vorschau tab.
  const vorschauTab = page.getByRole('tab', { name: /Vorschau|Preview/i });
  await vorschauTab.click();
  await page.waitForTimeout(500);
  // Click Start to spawn the dev server (no-op if already running).
  const startBtn = page
    .locator('button')
    .filter({ hasText: /^Start$/ })
    .first();
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.click().catch(() => {});
  }
  // Wait for the iframe to load FocusBoard content.
  await page.waitForTimeout(7000);
  // Scroll to position the iframe in the viewport.
  const iframeEl = page.locator('iframe').first();
  await iframeEl.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  const out = path.join(outDir, 'preview.png');
  await page.screenshot({ path: out, fullPage: false });
  console.log('wrote', out);
  await ctx.close();
}

async function main() {
  console.log('capturing screenshots to', outDir);
  const browser = await chromium.launch({ headless: true });
  try {
    await captureMissionControl(browser);
    await captureGoalPlanner(browser);
    await capturePreview(browser);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
