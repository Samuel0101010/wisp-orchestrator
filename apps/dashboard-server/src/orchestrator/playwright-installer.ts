/**
 * Playwright auto-installer for the runtime-verifier agent.
 *
 * Layer 3 of the v1.8 verification stack (E2E in a real browser) needs
 * Chromium binaries on disk. We don't want to ship them with the plugin
 * (~170 MB per platform) and we don't want to redownload them per worktree.
 * Compromise: a single shared cache at
 *
 *   ~/.cache/agent-harness/playwright-browsers
 *
 * pointed to by the PLAYWRIGHT_BROWSERS_PATH env var. Every worktree shares
 * this cache, so the first `npx playwright install chromium` pays the
 * download cost and every later run is instant.
 *
 * The installer is idempotent: it checks whether a chromium dir already
 * exists at the cache path and only triggers a download when missing. It
 * never deletes the cache.
 *
 * The runtime-verifier agent calls `ensurePlaywrightCached()` once before
 * launching its Playwright tests. Tests that already declare a runner via
 * `@playwright/test` continue to work — they just inherit the env var.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export interface EnsurePlaywrightArgs {
  /** Override the cache root. Defaults to ~/.cache/agent-harness/playwright-browsers. */
  cachePath?: string;
  /** Working dir to invoke `npx` in. Defaults to a tmp dir so we don't pollute the harness repo. */
  cwd?: string;
  /** Hook for tests to stub the npx invocation. */
  execImpl?: typeof execa;
  /** Don't run the install — only check whether a cached chromium exists. */
  checkOnly?: boolean;
}

export interface EnsurePlaywrightResult {
  /** Path that should be passed as PLAYWRIGHT_BROWSERS_PATH to any subprocess that runs Playwright tests. */
  cachePath: string;
  /** True iff at least one `chromium-*` directory exists under cachePath. */
  cached: boolean;
  /** True iff we just ran `npx playwright install` and it succeeded. */
  installed: boolean;
  /** Set on install failure; cachePath remains valid but `cached` will be false. */
  error?: string;
}

export function defaultCachePath(): string {
  return path.join(os.homedir(), '.cache', 'agent-harness', 'playwright-browsers');
}

/**
 * A cache is considered "warm" if it contains at least one directory whose
 * name starts with `chromium-`. We don't care which exact version — Playwright
 * resolves the right binary at runtime based on the test runner's package.
 */
export function isPlaywrightCached(cachePath: string): boolean {
  try {
    if (!fs.existsSync(cachePath)) return false;
    const entries = fs.readdirSync(cachePath);
    return entries.some((e) => e.startsWith('chromium-'));
  } catch {
    return false;
  }
}

export async function ensurePlaywrightCached(
  args: EnsurePlaywrightArgs = {},
): Promise<EnsurePlaywrightResult> {
  const cachePath = args.cachePath ?? defaultCachePath();
  fs.mkdirSync(cachePath, { recursive: true });

  if (isPlaywrightCached(cachePath)) {
    return { cachePath, cached: true, installed: false };
  }

  if (args.checkOnly) {
    return { cachePath, cached: false, installed: false };
  }

  const exec = args.execImpl ?? execa;
  const cwd = args.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pw-install-'));

  try {
    await exec('npx', ['--yes', 'playwright', 'install', 'chromium'], {
      cwd,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cachePath },
      // Downloads can take a couple of minutes on slow connections.
      timeout: 10 * 60_000,
    });
    return {
      cachePath,
      cached: isPlaywrightCached(cachePath),
      installed: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      cachePath,
      cached: false,
      installed: false,
      error: msg,
    };
  }
}
