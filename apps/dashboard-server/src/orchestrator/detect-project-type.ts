/**
 * Detect what kind of runnable surface a repo presents.
 *
 * Pure-function classifier over a package.json. Used by:
 *   - boot-smoke: pick the right dev command + probe URL
 *   - runtime-verifier agent: decide whether Playwright is even applicable
 *     (no point running E2E against a pure library)
 *   - release-gate: warn when a "web-app" project has no DoD criteria
 *
 * The rules are deliberately conservative: when in doubt we return 'unknown'
 * rather than guessing, because guessing wrong leads to a smoke probe that
 * hangs on the wrong port and looks like a real failure.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ProjectType = 'web-app' | 'backend' | 'cli' | 'library' | 'unknown';

export interface ProjectDetection {
  type: ProjectType;
  /** Suggested dev/start command if applicable (`pnpm dev`, `pnpm start`, …). */
  devCommand: string | null;
  /** Suggested URL to probe once the dev server is up. */
  probeUrl: string | null;
  /** Reason for the classification — surfaced in runtime-report.md for debugging. */
  reason: string;
}

const WEB_FRAMEWORK_DEPS = [
  'vite',
  'next',
  'nuxt',
  '@sveltejs/kit',
  'astro',
  'remix',
  '@remix-run/dev',
  '@angular/core',
  'react-scripts',
] as const;

const BACKEND_FRAMEWORK_DEPS = [
  'fastify',
  'express',
  'hono',
  'koa',
  '@nestjs/core',
  '@hapi/hapi',
] as const;

/** Default probe URL when a web framework is detected but no PORT is declared. */
const DEFAULT_WEB_PROBE: Record<string, string> = {
  vite: 'http://127.0.0.1:5173/',
  next: 'http://127.0.0.1:3000/',
  nuxt: 'http://127.0.0.1:3000/',
  '@sveltejs/kit': 'http://127.0.0.1:5173/',
  astro: 'http://127.0.0.1:4321/',
  remix: 'http://127.0.0.1:3000/',
  '@remix-run/dev': 'http://127.0.0.1:3000/',
  '@angular/core': 'http://127.0.0.1:4200/',
  'react-scripts': 'http://127.0.0.1:3000/',
};

function readPkg(repoPath: string): Record<string, unknown> | null {
  try {
    const p = path.join(repoPath, 'package.json');
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function allDeps(pkg: Record<string, unknown>): Record<string, string> {
  const d = (pkg.dependencies as Record<string, string>) ?? {};
  const dd = (pkg.devDependencies as Record<string, string>) ?? {};
  return { ...d, ...dd };
}

function firstMatch(deps: Record<string, string>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (deps[c]) return c;
  return null;
}

function pickDevCommand(pkg: Record<string, unknown>, preferred: 'dev' | 'start'): string | null {
  const scripts = (pkg.scripts as Record<string, string>) ?? {};
  if (scripts[preferred]) return `pnpm ${preferred}`;
  if (preferred === 'dev' && scripts.start) return 'pnpm start';
  if (preferred === 'start' && scripts.dev) return 'pnpm dev';
  return null;
}

export function detectProjectType(repoPath: string): ProjectDetection {
  const pkg = readPkg(repoPath);
  if (!pkg) {
    return {
      type: 'unknown',
      devCommand: null,
      probeUrl: null,
      reason: 'no package.json at repo root',
    };
  }

  const deps = allDeps(pkg);

  const web = firstMatch(deps, WEB_FRAMEWORK_DEPS);
  if (web) {
    return {
      type: 'web-app',
      devCommand: pickDevCommand(pkg, 'dev'),
      probeUrl: DEFAULT_WEB_PROBE[web] ?? 'http://127.0.0.1:3000/',
      reason: `web framework detected: ${web}`,
    };
  }

  const backend = firstMatch(deps, BACKEND_FRAMEWORK_DEPS);
  if (backend) {
    return {
      type: 'backend',
      devCommand: pickDevCommand(pkg, 'start'),
      probeUrl: 'http://127.0.0.1:3000/',
      reason: `backend framework detected: ${backend}`,
    };
  }

  if (pkg.bin) {
    return {
      type: 'cli',
      devCommand: null,
      probeUrl: null,
      reason: 'package.json declares `bin` — treated as CLI',
    };
  }

  if (pkg.main || pkg.exports) {
    return {
      type: 'library',
      devCommand: null,
      probeUrl: null,
      reason: 'package.json declares `main`/`exports` and no app framework — treated as library',
    };
  }

  return {
    type: 'unknown',
    devCommand: null,
    probeUrl: null,
    reason: 'package.json has neither a runnable framework nor a `bin`/`main` field',
  };
}
