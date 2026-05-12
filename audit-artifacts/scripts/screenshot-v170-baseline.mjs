// v1.7.0 baseline screenshot script. EN-only, both themes, 12 routes.
// Run from repo root: node audit-artifacts/scripts/screenshot-v170-baseline.mjs

import { chromium } from '../../tests/e2e/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_DIR = resolve(REPO_ROOT, 'audit-artifacts', 'screenshots');

const BASE_URL = 'http://localhost:5173';
const API_BASE = 'http://localhost:4400';

const STATIC_ROUTES = [
  ['home', '/'],
  ['chat', '/chat'],
  ['agents', '/agents'],
  ['skills', '/skills'],
  ['workers', '/workers'],
  ['insights', '/insights'],
  ['goap', '/goap'],
  ['prompt-bundles', '/prompt-bundles'],
];

const THEMES = ['dark', 'light'];
const LANG = 'en';

async function fetchJson(path) {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`fetch ${path} failed:`, err.message);
    return null;
  }
}

async function buildProjectRoutes() {
  const projects = await fetchJson('/api/projects');
  if (!Array.isArray(projects) || projects.length === 0) {
    return { routes: [], notes: ['No projects available — project routes skipped.'] };
  }
  const project = projects[projects.length - 1];
  const pid = project.id;
  const routes = [
    ['project-detail', `/projects/${pid}`],
    ['project-teams', `/projects/${pid}/teams`],
    ['project-plan', `/projects/${pid}/plan`],
  ];
  const runs = await fetchJson('/api/runs?limit=1');
  const run = runs?.runs?.[0];
  const notes = [];
  if (run) {
    routes.push(['project-run', `/projects/${pid}/run/${run.id}`]);
  } else {
    notes.push('No runs available — run route skipped.');
  }
  return { routes, notes, project };
}

async function captureOne(browser, route, slugName, theme) {
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
      } catch {}
    },
    { lang: LANG, theme },
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const file = resolve(OUT_DIR, `v1.7.0-baseline-${slugName}-${theme}.png`);
  let status = 'ok';
  try {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    try {
      await page.waitForSelector('[data-testid="sidebar-mission-control"]', { timeout: 8000 });
    } catch {
      status = 'sidebar-missing';
    }
    await page.waitForTimeout(900);
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

  const { routes: projectRoutes, notes } = await buildProjectRoutes();
  const allRoutes = [...STATIC_ROUTES, ...projectRoutes];

  console.log(`Total routes: ${allRoutes.length}`);
  console.log(`Total shots: ${allRoutes.length * THEMES.length}`);
  if (notes.length) console.log('Notes:', notes.join(' | '));

  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const [slugName, route] of allRoutes) {
    for (const theme of THEMES) {
      const r = await captureOne(browser, route, slugName, theme);
      console.log(`[${r.status}] ${slugName} ${theme} -> ${r.file}`);
      results.push({ slugName, route, theme, ...r });
    }
  }
  await browser.close();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
