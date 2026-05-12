// Standalone screenshot script for Agent Harness v1.6.0 QA pass.
// Captures every (route x theme x lang) variant at 1440x900 fullPage.
//
// Run from repo root: node audit-artifacts/scripts/screenshot-all.mjs

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
  ['root', '/'],
  ['chat', '/chat'],
  ['agents', '/agents'],
  ['skills', '/skills'],
  ['workers', '/workers'],
  ['insights', '/insights'],
  ['goap', '/goap'],
  ['prompt-bundles', '/prompt-bundles'],
];

const THEMES = ['dark', 'light'];
const LANGS = ['en', 'de'];

function slug(s) {
  return (
    s
      .replace(/[^a-z0-9-]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'root'
  );
}

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
    console.warn('No projects available; skipping project-scoped routes.');
    return { routes: [], notes: ['No projects available — project routes skipped.'] };
  }
  // Prefer most recently created project for richest UI.
  const project = projects[projects.length - 1];
  const pid = project.id;
  const routes = [
    [`project-${slug(project.name)}`, `/projects/${pid}`],
    [`project-${slug(project.name)}-teams`, `/projects/${pid}/teams`],
    [`project-${slug(project.name)}-plan`, `/projects/${pid}/plan`],
  ];

  const runs = await fetchJson('/api/runs?limit=1');
  const run = runs?.runs?.[0];
  const notes = [];
  if (run) {
    routes.push([
      `project-${slug(project.name)}-run-${run.id.slice(0, 8)}`,
      `/projects/${pid}/run/${run.id}`,
    ]);
  } else {
    notes.push('No runs available — run route skipped.');
  }
  return { routes, notes, project };
}

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
  const file = resolve(OUT_DIR, `v1.6.0-qa-${slugName}-${theme}-${lang}.png`);
  let status = 'ok';
  try {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      await page.waitForSelector('[data-testid="sidebar-mission-control"]', { timeout: 8000 });
    } catch {
      status = 'sidebar-missing';
    }
    // Small settle for late renders.
    await page.waitForTimeout(800);
    await page.screenshot({ path: file, fullPage: true });
  } catch (err) {
    status = `error: ${err.message}`;
    // best-effort screenshot anyway
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
  console.log(`Total shots: ${allRoutes.length * THEMES.length * LANGS.length}`);
  if (notes.length) console.log('Notes:', notes.join(' | '));

  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const [slugName, route] of allRoutes) {
    for (const theme of THEMES) {
      for (const lang of LANGS) {
        const r = await captureOne(browser, route, slugName, theme, lang);
        console.log(`[${r.status}] ${slugName} ${theme}/${lang} -> ${r.file}`);
        results.push({ slugName, route, theme, lang, ...r });
      }
    }
  }
  await browser.close();

  // Emit a JSON manifest the report step can consume.
  const manifestPath = resolve(OUT_DIR, '..', 'qa-screenshot-manifest.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(manifestPath, JSON.stringify({ notes, results }, null, 2), 'utf8');
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
