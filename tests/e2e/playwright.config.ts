import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const dashboardServerEntry = path.join(repoRoot, 'apps', 'dashboard-server', 'dist', 'server.js');

const PORT = Number(process.env.WISP_E2E_PORT ?? 4499);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

/**
 * Create the per-run state SYNCHRONOUSLY at config-load time so the values are
 * available to the webServer block (which Playwright reads before globalSetup
 * runs). Each test invocation gets a fresh data dir + tmp git repo.
 */
function makeState(): { dataDir: string; repoPath: string } {
  const dataDir =
    process.env.WISP_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-e2e-data-'));
  let repoPath = process.env.WISP_E2E_REPO_PATH;
  if (!repoPath) {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-repo-'));
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repoPath, env, stdio: 'pipe' });
    };
    git('init', '-b', 'main');
    git('config', 'user.email', 'e2e@example.com');
    git('config', 'user.name', 'E2E Test');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# e2e fixture\n');
    git('add', 'README.md');
    git('commit', '-m', 'initial commit');
  }
  // Re-export so the smoke spec can read the repo path inside the test process.
  process.env.WISP_E2E_DATA_DIR = dataDir;
  process.env.WISP_E2E_REPO_PATH = repoPath;
  return { dataDir, repoPath };
}

const { dataDir } = makeState();

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 0 : 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: path.join(here, 'global-setup.ts'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium-en',
      use: { ...devices['Desktop Chrome'], locale: 'en-US' },
      metadata: { lang: 'en' as const },
    },
    {
      name: 'chromium-de',
      use: { ...devices['Desktop Chrome'], locale: 'de-DE' },
      metadata: { lang: 'de' as const },
    },
  ],
  webServer: {
    command: `pnpm --filter dashboard-web build && pnpm --filter dashboard-server build && node "${dashboardServerEntry}"`,
    url: `${BASE_URL}/api/health`,
    timeout: 60_000,
    // Always start a fresh server so each invocation gets a fresh tmp
    // WISP_DATA_DIR rather than inheriting a polluted DB from a prior dev
    // run.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      WISP_PORT: String(PORT),
      WISP_HOST: HOST,
      WISP_MOCK_CLI: '1',
      WISP_SERVE_WEB: '1',
      WISP_LOG_LEVEL: 'warn',
      WISP_DATA_DIR: dataDir,
    },
  },
});
