#!/usr/bin/env node
/**
 * agent-harness doctor — quick sanity check for the v1.8 runtime-verifier.
 *
 * The runtime-verifier needs Chromium on disk under
 * ~/.cache/wisp/playwright-browsers to drive the user's app in a
 * real browser. This script reports whether the cache is warm, and if not,
 * prints the exact one-liner to populate it. Safe to run any time; never
 * downloads anything itself.
 *
 *   pnpm doctor
 *
 * Exits 0 always (it's diagnostic, not a CI gate). Output is intentionally
 * compact: one line per check + a hint when something is off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cachePath = path.join(os.homedir(), '.cache', 'wisp', 'playwright-browsers');

const checks = [];

function ok(label, detail) {
  checks.push({ status: 'ok', label, detail });
}
function warn(label, detail, hint) {
  checks.push({ status: 'warn', label, detail, hint });
}

// Node version — floor 20.10; soft upper bound matches the better-sqlite3
// prebuild matrix (pinned 12.9.0 ships prebuilts through Node 25).
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 10)) {
  warn(
    'Node.js',
    `v${process.versions.node}`,
    'WISP requires Node >= 20.10 (Node 22 or 24 LTS recommended)',
  );
} else if (nodeMajor > 25) {
  warn(
    'Node.js',
    `v${process.versions.node}`,
    'Newer than the tested range; if install fails on better-sqlite3, use Node 24 LTS (a prebuilt binary exists — no compiler needed)',
  );
} else {
  ok('Node.js', `v${process.versions.node}`);
}

// pnpm
try {
  const v = execSync('pnpm --version', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  ok('pnpm', `v${v}`);
} catch {
  warn(
    'pnpm',
    'not on PATH',
    'Optional — corepack (bundled with Node) provides pnpm; or: npm i -g pnpm@10.33.2',
  );
}

// better-sqlite3 native module — the #1 reason a dashboard won't start. Load it
// under THIS Node to catch an ABI mismatch (the .node binary was built for a
// different Node version, e.g. installed by the Claude Code CLI's bundled Node
// but run under the system Node) before the server crashes on it.
try {
  const requireFromServer = createRequire(
    path.join(repoRoot, 'apps', 'dashboard-server', 'package.json'),
  );
  requireFromServer('better-sqlite3');
  ok('better-sqlite3', `native module loads under Node v${process.versions.node}`);
} catch (err) {
  const m = err instanceof Error ? err.message : String(err);
  if (/NODE_MODULE_VERSION|different Node|was compiled against|\.node\b/i.test(m)) {
    warn(
      'better-sqlite3',
      `built for a different Node than v${process.versions.node} (ABI mismatch)`,
      'Rebuild it: pnpm rebuild better-sqlite3 — or just re-run /wisp-dashboard (it auto-rebuilds)',
    );
  } else {
    warn(
      'better-sqlite3',
      'not installed / not loadable',
      'Run /wisp-dashboard once to install + build, or `pnpm install` from the repo root',
    );
  }
}

// claude CLI
try {
  execSync('claude --version', { stdio: ['ignore', 'pipe', 'ignore'] });
  ok('Claude Code CLI', 'on PATH');
} catch {
  warn(
    'Claude Code CLI',
    'not on PATH',
    'Install the official `claude` binary so the orchestrator can dispatch tasks',
  );
}

// git
try {
  const v = execSync('git --version', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  ok('git', v);
} catch {
  warn('git', 'not on PATH', 'git is required for per-task worktrees');
}

// Playwright cache (the v1.8 runtime-verifier)
const cached =
  fs.existsSync(cachePath) && fs.readdirSync(cachePath).some((e) => e.startsWith('chromium-'));
if (cached) {
  ok('Playwright cache', `chromium present at ${cachePath}`);
} else {
  warn(
    'Playwright cache',
    `chromium not yet downloaded at ${cachePath}`,
    `Populate it once: PLAYWRIGHT_BROWSERS_PATH="${cachePath}" npx playwright install chromium`,
  );
}

// npx availability (the runtime-verifier shells out to npx)
try {
  execSync('npx --version', { stdio: ['ignore', 'pipe', 'ignore'] });
  ok('npx', 'on PATH');
} catch {
  warn('npx', 'not on PATH', 'npx ships with npm — install Node.js with bundled npm');
}

// Rust toolchain — required by the v1.15 Tauri packager. Non-fatal: only
// matters when the user wants to ship a native installer.
try {
  const v = execSync('cargo --version', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  ok('Rust (cargo)', v);
} catch {
  warn(
    'Rust (cargo)',
    'not on PATH',
    'Install Rust: https://rustup.rs — required for Tauri native packaging.',
  );
}

// Tauri CLI — required by the v1.15 packager.
try {
  const v = execSync('pnpm exec tauri --version', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  ok('Tauri CLI', v);
} catch {
  warn(
    'Tauri CLI',
    'not on PATH',
    'Install Tauri CLI: pnpm add -g @tauri-apps/cli (only needed for tauri-exe packageTarget).',
  );
}

const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
console.log('agent-harness doctor — runtime checks for v1.8\n');
for (const c of checks) {
  const icon = c.status === 'ok' ? '✓' : '⚠';
  console.log(`  ${icon} ${pad(c.label, 24)} ${c.detail}`);
  if (c.hint) console.log(`     → ${c.hint}`);
}

const warnCount = checks.filter((c) => c.status !== 'ok').length;
console.log();
if (warnCount === 0) {
  console.log('All checks passed. The runtime-verifier should be able to run.');
} else {
  console.log(`${warnCount} check(s) need attention. The harness will still run, but`);
  console.log('runtime-verify may degrade until the items above are addressed.');
}
