#!/usr/bin/env node
/**
 * agent-harness doctor — quick sanity check for the v1.8 runtime-verifier.
 *
 * The runtime-verifier needs Chromium on disk under
 * ~/.cache/agent-harness/playwright-browsers to drive the user's app in a
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

const cachePath = path.join(os.homedir(), '.cache', 'agent-harness', 'playwright-browsers');

const checks = [];

function ok(label, detail) {
  checks.push({ status: 'ok', label, detail });
}
function warn(label, detail, hint) {
  checks.push({ status: 'warn', label, detail, hint });
}

// Node version
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= 20) {
  ok('Node.js', `v${process.versions.node}`);
} else {
  warn('Node.js', `v${process.versions.node}`, 'Agent Harness requires Node >= 20.10');
}

// pnpm
try {
  const v = execSync('pnpm --version', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
  ok('pnpm', `v${v}`);
} catch {
  warn('pnpm', 'not on PATH', 'Install pnpm: npm i -g pnpm');
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
