import './setup.js';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { runBootSmoke } from '../orchestrator/boot-smoke.js';

/**
 * Build a minimal ChildProcess stub good enough for runBootSmoke. The real
 * thing is opaque on Windows; here we only care that:
 *   - stdout/stderr emit data we surface in the tail
 *   - the .once('exit') listener fires when we say so
 *   - .pid is set so killTree's branch is taken without throwing
 */
function fakeChild(): ChildProcess & {
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  emitExit: (code: number) => void;
} {
  const e = new EventEmitter() as ChildProcess & {
    emitStdout: (s: string) => void;
    emitStderr: (s: string) => void;
    emitExit: (code: number) => void;
  };
  e.stdout = new EventEmitter() as ChildProcess['stdout'];
  e.stderr = new EventEmitter() as ChildProcess['stderr'];
  e.pid = 99999;
  e.exitCode = null;
  e.signalCode = null;
  e.kill = vi.fn().mockReturnValue(true) as ChildProcess['kill'];
  e.emitStdout = (s) => e.stdout?.emit('data', Buffer.from(s, 'utf8'));
  e.emitStderr = (s) => e.stderr?.emit('data', Buffer.from(s, 'utf8'));
  e.emitExit = (code) => {
    e.exitCode = code;
    e.emit('exit', code, null);
  };
  return e;
}

describe('runBootSmoke', () => {
  it('returns ok when the probe URL answers with a non-5xx status', async () => {
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    // Probe answers 200 immediately.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await runBootSmoke({
      repoPath: '/tmp/x',
      devCommand: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      pollIntervalMs: 50,
      fetchImpl,
      spawnImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sampledStatus).toBe(200);
    }
  });

  it('accepts a 302 redirect on `/` as a healthy boot', async () => {
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 302 });
    const result = await runBootSmoke({
      repoPath: '/tmp/x',
      devCommand: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      pollIntervalMs: 50,
      fetchImpl,
      spawnImpl,
    });
    expect(result.ok).toBe(true);
  });

  it('times out when the probe URL never answers', async () => {
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await runBootSmoke({
      repoPath: '/tmp/x',
      devCommand: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 300,
      pollIntervalMs: 50,
      fetchImpl,
      spawnImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout');
      expect(result.detail).toContain('ECONNREFUSED');
    }
  });

  it('reports crashed when the dev process exits early', async () => {
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const p = runBootSmoke({
      repoPath: '/tmp/x',
      devCommand: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 5000,
      pollIntervalMs: 50,
      fetchImpl,
      spawnImpl,
    });
    // Let the first poll cycle happen, then simulate the process dying.
    await new Promise((r) => setTimeout(r, 80));
    child.emitStderr('Error: cannot find module foo\n');
    child.emitExit(1);
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('crashed');
      expect(result.stderrTail).toContain('cannot find module foo');
    }
  });

  it('returns spawn-failed when the spawn itself throws', async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('ENOENT pnpm');
    }) as unknown as typeof import('node:child_process').spawn;
    const result = await runBootSmoke({
      repoPath: '/tmp/x',
      devCommand: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 100,
      pollIntervalMs: 25,
      fetchImpl: vi.fn(),
      spawnImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('spawn-failed');
      expect(result.detail).toContain('ENOENT');
    }
  });
});
