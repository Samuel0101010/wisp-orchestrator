// Captures the REAL Focusboard live-preview feature with the TipJar app (a
// finished wisp-built project whose `main` carries the full source) for the
// case study: the running app inside the dashboard's preview box (in context
// AND a close-up of the box + toolbar), the desktop⇄mobile device switch, a
// design+feature change-request queue, and a real redesign (the app's own
// light/dark theme toggle) reflected live in the box.
//
// Preconditions:
//   - dashboard on http://localhost:4400 (WISP_SERVE_WEB=1)
//   - TipJar preview started: POST /api/projects/<id>/preview/start (→ running)
//
// Output: public/screenshots/focusboard-preview.png, -mobile.png, -iterate.png,
//         preview-box.png, preview-box-light.png
//
// Usage:  node scripts/capture-preview.mjs
import { chromium } from '../../../tests/e2e/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'screenshots');
const BASE = process.env.WISP_DASHBOARD ?? 'http://localhost:4400';
const PROJ = process.env.PROJ ?? '65bd5151-4b8a-42ad-ba74-88c295bb7fe2'; // TipJar

const shot = (page, name) => page.screenshot({ path: resolve(OUT_DIR, `${name}.png`), fullPage: false });
const box = (page, name) =>
  page.locator('[data-testid="preview-frame"]').screenshot({ path: resolve(OUT_DIR, `${name}.png`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    locale: 'en-US',
  });
  // Dashboard dark theme + seed the TipJar app's own theme to dark (it reads
  // localStorage 'theme'; same origin via the proxy → reaches the iframe app).
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'wisp-ui',
        JSON.stringify({ state: { theme: 'dark', sidebarCollapsed: false, favoriteProjectIds: [] }, version: 0 }),
      );
      window.localStorage.setItem('theme', 'dark');
    } catch {
      /* ignore */
    }
  });

  const page = await ctx.newPage();
  await page.goto(`${BASE}/focus/${PROJ}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 5000 }).catch(() => {});

  // Wait for the live preview iframe + the TipJar card inside it.
  await page.locator('[data-testid="preview-iframe"]').waitFor({ timeout: 25000 });
  const app = page.frameLocator('[data-testid="preview-iframe"]');
  await app.locator('.card').waitFor({ timeout: 25000 });
  await sleep(800);

  // Fill the calculator so the preview shows a live, computed result.
  await app.locator('#bill-amount').fill('58.40').catch(() => {});
  await app.locator('.tip-presets button', { hasText: '20' }).first().click().catch(() => {});
  await app.locator('[aria-label="Increase number of people"]').click().catch(() => {});
  await sleep(700);

  // Desktop — in context + a close-up of the preview box & toolbar.
  await page.getByTestId('preview-viewport-desktop').click().catch(() => {});
  await sleep(500);
  await shot(page, 'focusboard-preview');
  await box(page, 'preview-box');
  process.stdout.write('-> focusboard-preview.png + preview-box.png\n');

  // Mobile — device switch.
  await page.getByTestId('preview-viewport-mobile').click();
  await sleep(900);
  await shot(page, 'focusboard-mobile');
  process.stdout.write('-> focusboard-mobile.png\n');
  await page.getByTestId('preview-viewport-desktop').click();
  await sleep(500);

  // Iterate — queue a design change + a feature, show the list + Run Iteration.
  const ta = page.getByTestId('text-mode-textarea');
  const submit = page.getByTestId('text-mode-submit');
  for (const c of [
    'Redesign the card with a bolder header and rounded inputs.',
    'Add a “round up the tip” toggle and a currency selector.',
  ]) {
    await ta.fill(c);
    await submit.click();
    await sleep(700);
  }
  await page.getByTestId('pending-changes-panel').scrollIntoViewIfNeeded().catch(() => {});
  await sleep(500);
  await shot(page, 'focusboard-iterate');
  process.stdout.write('-> focusboard-iterate.png\n');

  // Redesign — toggle the app's own theme (dark → light), shown live in the box.
  await page.locator('[data-testid="preview-viewport-desktop"]').click().catch(() => {});
  await app.locator('.theme-toggle').click().catch(() => {});
  await sleep(900);
  await box(page, 'preview-box-light');
  process.stdout.write('-> preview-box-light.png\n');

  // cleanup the seeded change-requests
  for (;;) {
    const del = page.locator('[data-testid^="pending-delete-"]').first();
    if ((await del.count()) === 0) break;
    await del.click().catch(() => {});
    await sleep(400);
  }

  await ctx.close();
  await browser.close();
  console.log(`\nSaved TipJar preview screenshots to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
