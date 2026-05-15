import './setup.js';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePlaywrightCached,
  isPlaywrightCached,
  defaultCachePath,
} from '../orchestrator/playwright-installer.js';

describe('playwright-installer', () => {
  const tmpDirs: string[] = [];
  beforeEach(() => {
    tmpDirs.length = 0;
  });
  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function tmpCache(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-cache-'));
    tmpDirs.push(d);
    return d;
  }

  it('defaultCachePath points under the home directory', () => {
    const p = defaultCachePath();
    expect(p.startsWith(os.homedir())).toBe(true);
    expect(p).toContain('agent-harness');
  });

  it('isPlaywrightCached returns false for an empty directory', () => {
    expect(isPlaywrightCached(tmpCache())).toBe(false);
  });

  it('isPlaywrightCached returns true when a chromium-* dir exists', () => {
    const c = tmpCache();
    fs.mkdirSync(path.join(c, 'chromium-1129'));
    expect(isPlaywrightCached(c)).toBe(true);
  });

  it('skips install when cache is already warm', async () => {
    const c = tmpCache();
    fs.mkdirSync(path.join(c, 'chromium-1129'));
    const execImpl = vi.fn();
    const r = await ensurePlaywrightCached({ cachePath: c, execImpl: execImpl as never });
    expect(r.cached).toBe(true);
    expect(r.installed).toBe(false);
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('runs npx playwright install when cache is cold and reports success', async () => {
    const c = tmpCache();
    const execImpl = vi.fn().mockImplementation(async () => {
      // Simulate the install by creating the chromium dir.
      fs.mkdirSync(path.join(c, 'chromium-1129'));
      return { stdout: '', stderr: '' };
    });
    const r = await ensurePlaywrightCached({ cachePath: c, execImpl: execImpl as never });
    expect(execImpl).toHaveBeenCalledOnce();
    const callArgs = execImpl.mock.calls[0];
    expect(callArgs[0]).toBe('npx');
    expect(callArgs[1]).toEqual(['--yes', 'playwright', 'install', 'chromium']);
    expect(r.installed).toBe(true);
    expect(r.cached).toBe(true);
  });

  it('reports an error when the npx invocation throws', async () => {
    const c = tmpCache();
    const execImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const r = await ensurePlaywrightCached({ cachePath: c, execImpl: execImpl as never });
    expect(r.installed).toBe(false);
    expect(r.cached).toBe(false);
    expect(r.error).toContain('network down');
  });

  it('respects checkOnly — never invokes execa even when cache is cold', async () => {
    const c = tmpCache();
    const execImpl = vi.fn();
    const r = await ensurePlaywrightCached({
      cachePath: c,
      checkOnly: true,
      execImpl: execImpl as never,
    });
    expect(execImpl).not.toHaveBeenCalled();
    expect(r.cached).toBe(false);
    expect(r.installed).toBe(false);
  });
});
