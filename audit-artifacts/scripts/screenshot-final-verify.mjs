// Final-verify screenshot script for v1.6.0 role-color bug fix re-verify.
// Captures 8 shots: (plan, run) × (light, dark) × (en, de) for the locked project.
// Run from repo root: node audit-artifacts/scripts/screenshot-final-verify.mjs

import { chromium } from '../../tests/e2e/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_DIR = resolve(REPO_ROOT, 'audit-artifacts', 'screenshots');

const BASE_URL = 'http://localhost:5173';
const PROJECT_ID = '28577a95-6c48-420f-814a-9e1fdb4d36b0';
const RUN_ID = '008bd6f3-88aa-4fb3-a24d-5f50976786fc';

const ROUTES = [
  ['plan', `/projects/${PROJECT_ID}/plan`],
  ['run', `/projects/${PROJECT_ID}/run/${RUN_ID}`],
];

const THEMES = ['light', 'dark'];
const LANGS = ['en', 'de'];

async function captureOne(browser, route, slugName, theme, lang) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  ctx.on('weberror', (e) => errors.push(`weberror: ${e.error().message}`));
  await ctx.addInitScript(
    ({ lang, theme }) => {
      try {
        localStorage.setItem('agent-harness-lang', lang);
        localStorage.setItem('agent-harness-ui', JSON.stringify({ state: { theme }, version: 0 }));
      } catch (e) {
        // ignore
      }
    },
    { lang, theme },
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const file = resolve(OUT_DIR, `v1.6.0-final-${slugName}-${theme}-${lang}.png`);
  let status = 'ok';
  try {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      await page.waitForSelector('[data-testid="sidebar-mission-control"]', { timeout: 8000 });
    } catch {
      status = 'sidebar-missing';
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: file, fullPage: true });
  } catch (err) {
    status = `error: ${err.message}`;
    try {
      await page.screenshot({ path: file, fullPage: true });
    } catch {}
  }
  await ctx.close();
  return { file, status, errors };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const [slugName, route] of ROUTES) {
    for (const theme of THEMES) {
      for (const lang of LANGS) {
        const r = await captureOne(browser, route, slugName, theme, lang);
        console.log(`[${r.status}] ${slugName} ${theme}/${lang} -> ${r.file}`);
        if (r.errors.length) console.log(`  errors: ${r.errors.join(' | ')}`);
        results.push({ slugName, route, theme, lang, ...r });
      }
    }
  }
  await browser.close();
  console.log(`Done. ${results.length} shots.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
