import './setup.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';
import net from 'node:net';
import {
  PreviewProcessRegistry,
  previewProcesses,
  isPortFree,
  ensurePreviewWorktree,
  cleanupPreviewWorktree,
} from '../orchestrator/preview-server.js';
import { dirname, join, resolve } from 'node:path';

// Mock fs/promises so ensurePreviewWorktree's mkdir / access / rm don't touch
// the real disk. `access` rejection means "node_modules absent" → install runs;
// resolution means "present" → install is skipped. The test toggles
// `nodeModulesPresent` per-case.
let nodeModulesPresent = false;
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockImplementation(async () => {
      if (!nodeModulesPresent) throw new Error('ENOENT');
    }),
  };
});

/**
 * A ChildProcess stub good enough for `startPreview` — same shape as the one
 * in `boot-smoke.test.ts`. We don't actually spawn `pnpm dev` here; instead
 * we let the registry think the spawn succeeded and have its fetch poll hit
 * a small in-process http server (or a vi.fn stub).
 */
function fakeChild(): ChildProcess {
  const e = new EventEmitter() as ChildProcess;
  e.stdout = new EventEmitter() as ChildProcess['stdout'];
  e.stderr = new EventEmitter() as ChildProcess['stderr'];
  (e as { pid: number }).pid = 99999;
  (e as { exitCode: number | null }).exitCode = null;
  (e as { signalCode: NodeJS.Signals | null }).signalCode = null;
  e.kill = vi.fn().mockReturnValue(true) as ChildProcess['kill'];
  return e;
}

async function listenLoopback(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen-failed');
  return { server, port: addr.port };
}

describe('isPortFree dual-stack probe', () => {
  it('returns false when only the IPv6 loopback half is held', async () => {
    // Bind only ::1 to simulate the Windows zombie-vite pattern where the
    // dead process kept the IPv6 socket alive but not the IPv4 one. A
    // single-family probe would falsely report this port free.
    const ipv6Holder = net.createServer();
    await new Promise<void>((resolve, reject) => {
      ipv6Holder.once('error', reject);
      ipv6Holder.listen(0, '::1', resolve);
    });
    const addr = ipv6Holder.address();
    if (!addr || typeof addr === 'string') throw new Error('no-port');
    try {
      const free = await isPortFree(addr.port);
      expect(free).toBe(false);
    } finally {
      await new Promise<void>((resolve) => ipv6Holder.close(() => resolve()));
    }
  });
});

describe('PreviewProcessRegistry', () => {
  let registry: PreviewProcessRegistry;

  afterEach(() => {
    registry?.__test_reset();
  });

  it('startPreview returns running once the probe URL answers', async () => {
    registry = new PreviewProcessRegistry();
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    // First call: no response; second call: 200.
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl: async () => true,
    });
    expect(result.status).toBe('running');
    expect(result.port).toBe(5173);
    // Pass a stub pidAlive — the fakeChild has a bogus pid that the OS
    // would correctly report as dead.
    const status = registry.getPreviewStatus('p1', { pidAliveImpl: () => true });
    expect(status.running).toBe(true);
    expect(status.port).toBe(5173);
  });

  it('startPreview returns port_occupied without spawning when all ports busy', async () => {
    registry = new PreviewProcessRegistry();
    const spawnImpl = vi.fn() as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn();
    const isPortFreeImpl = vi.fn().mockResolvedValue(false);
    const result = await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl,
    });
    expect(result.status).toBe('error');
    expect(result.error).toBe('port_occupied');
    expect(result.port).toBe(5173);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const status = registry.getPreviewStatus('p1');
    expect(status.running).toBe(false);
    expect(status.status).toBe('error');
    expect(status.error).toBe('port-occupied');
  });

  it('startPreview appends --base when basePath is set', async () => {
    registry = new PreviewProcessRegistry();
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      basePath: '/preview/abc/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl: async () => true,
    });
    expect(result.status).toBe('running');
    const callArgs = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const argv = callArgs?.[1] as string[];
    // argv should contain `--base /preview/abc/` AFTER the `--port` pair.
    const baseIdx = argv.indexOf('--base');
    expect(baseIdx).toBeGreaterThan(-1);
    expect(argv[baseIdx + 1]).toBe('/preview/abc/');
  });

  it('startPreview does NOT append --base when basePath is omitted', async () => {
    registry = new PreviewProcessRegistry();
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl: async () => true,
    });
    const callArgs = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const argv = callArgs?.[1] as string[];
    expect(argv).not.toContain('--base');
  });

  it('startPreview falls back to the next free port when the requested one is busy', async () => {
    registry = new PreviewProcessRegistry();
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    // First two ports busy, third is free.
    const isPortFreeImpl = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const result = await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl,
    });
    expect(result.status).toBe('running');
    expect(result.port).toBe(5175);
    // The child was spawned with PORT=5175 in env.
    const callArgs = (spawnImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs?.[2]?.env?.PORT).toBe('5175');
    // The probe URL the registry polled was rewritten to the chosen port.
    const fetchCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    // probeUrl is normalised to `localhost` so the system resolver picks
    // whichever loopback family vite actually bound to (Windows: ::1).
    expect(fetchCall?.[0]).toBe('http://localhost:5175/');
  });

  it('getPreviewStatus mutates entry to error when the registered pid is dead', () => {
    registry = new PreviewProcessRegistry();
    registry.__test_register({ projectId: 'p1', port: 5173, pid: 39164 });
    // First call uses an alive-stub so we observe the pre-mutation state.
    expect(registry.getPreviewStatus('p1', { pidAliveImpl: () => true }).running).toBe(true);
    const status = registry.getPreviewStatus('p1', { pidAliveImpl: () => false });
    expect(status.running).toBe(false);
    expect(status.status).toBe('error');
    expect(status.error).toBe('process-died');
    // The mutation persists across calls — even without the override.
    const again = registry.getPreviewStatus('p1');
    expect(again.status).toBe('error');
    expect(again.error).toBe('process-died');
  });

  it('getPreviewStatus leaves running entries alone when pid is alive', () => {
    registry = new PreviewProcessRegistry();
    registry.__test_register({ projectId: 'p1', port: 5173, pid: 39164 });
    const status = registry.getPreviewStatus('p1', { pidAliveImpl: () => true });
    expect(status.running).toBe(true);
    expect(status.status).toBe('running');
  });

  it('post-startup exit flips a running entry to error with process-died', async () => {
    registry = new PreviewProcessRegistry();
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl: async () => true,
    });
    expect(result.status).toBe('running');
    // Crash AFTER the ready probe succeeded: stderr noise, then exit. Mark the
    // fake child as exited so killTree (afterEach reset) short-circuits.
    child.stderr?.emit('data', Buffer.from('Segmentation fault'));
    (child as { exitCode: number | null }).exitCode = 1;
    child.emit('exit', 1, null);
    // No pid probing here — the exit handler alone must have flipped the entry.
    const status = registry.getPreviewStatus('p1');
    expect(status.running).toBe(false);
    expect(status.status).toBe('error');
    expect(status.error?.startsWith('process-died')).toBe(true);
    expect(status.error).toContain('Segmentation fault');
  });

  it('stop-then-exit does not resurrect a stopped preview as crashed', async () => {
    registry = new PreviewProcessRegistry();
    const child = fakeChild();
    const spawnImpl = vi
      .fn()
      .mockReturnValue(child) as unknown as typeof import('node:child_process').spawn;
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 });
    const result = await registry.startPreview({
      projectId: 'p1',
      devCmd: 'pnpm dev',
      probeUrl: 'http://127.0.0.1:5173/',
      readyTimeoutMs: 2000,
      fetchImpl,
      spawnImpl,
      isPortFreeImpl: async () => true,
    });
    expect(result.status).toBe('running');
    // Mark the fake child as exited so stopPreview's killTree short-circuits
    // (no real taskkill); the OS-level exit still arrives asynchronously below.
    (child as { exitCode: number | null }).exitCode = 1;
    expect(registry.stopPreview('p1').stopped).toBe(true);
    // Windows ordering: stopPreview deleted the entry, THEN the tree-kill
    // triggers exit. The entry-identity guard must keep the map empty.
    child.emit('exit', null, 'SIGTERM');
    expect(registry.getPreviewStatus('p1')).toEqual({ running: false });
  });

  it('stopPreview flips status back and is idempotent', async () => {
    registry = new PreviewProcessRegistry();
    registry.__test_register({ projectId: 'p2', port: 5174, pid: 1234 });
    expect(registry.getPreviewStatus('p2', { pidAliveImpl: () => true }).running).toBe(true);
    const a = registry.stopPreview('p2');
    expect(a.stopped).toBe(true);
    const b = registry.stopPreview('p2');
    expect(b.stopped).toBe(false);
    expect(registry.getPreviewStatus('p2').running).toBe(false);
  });
});

describe('preview reverse-proxy', () => {
  let app: FastifyInstance;
  let upstream: http.Server;
  let upstreamPort: number;
  const projectId = 'proj-preview-1';

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
    // Seed a project — startPreview's pre-check needs it.
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'preview-test', goal: 'g', repoPath: '/tmp/preview-test' },
    });
    // Find the seeded id — the project route returns whatever was inserted.
    // For simplicity we'll inject the registry entry directly.
    const listening = await listenLoopback((req, res) => {
      // Echo the request path back so the test can assert that the proxy
      // forwarded the FULL `/preview/<id>/...` path (with `--base` semantics)
      // instead of stripping the prefix.
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end(`upstream-path=${req.url ?? ''}`);
    });
    upstream = listening.server;
    upstreamPort = listening.port;
    previewProcesses.__test_register({ projectId, port: upstreamPort, pid: null });
  });

  afterAll(async () => {
    previewProcesses.__test_reset();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await app.close();
    sqlite.close();
  });

  it('forwards a GET request to the live dev server', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/preview/${projectId}/`,
    });
    expect(res.statusCode).toBe(200);
    // With the --base fix the proxy forwards the full path (including the
    // `/preview/<id>/` prefix) instead of stripping it — vite serves its
    // assets under that prefix when launched with `--base /preview/<id>/`.
    expect(res.body).toBe(`upstream-path=/preview/${projectId}/`);
  });

  it('forwards a nested asset path with the prefix intact', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/preview/${projectId}/src/main.tsx`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`upstream-path=/preview/${projectId}/src/main.tsx`);
  });

  it('returns 502 with preview_not_running when no entry is registered', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/preview/no-such-project/',
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('preview_not_running');
  });
});

describe('ensurePreviewWorktree', () => {
  const repoPath = '/tmp/wisp-repo';
  const projectId = 'proj-wt-1';
  const sha = 'deadbeefcafe';
  const expectedWtPath = join(
    dirname(resolve(repoPath)),
    '.harness-worktrees',
    `preview-${projectId}`,
  );

  type ExecaCall = { cmd: string; args: string[] };

  /**
   * Build a fake `execa` whose behaviour is driven by the command + args. Each
   * call is recorded so the test can assert which git/pnpm subcommands ran.
   * `opts.worktreeExists` controls whether `worktree list` reports the path
   * (reuse path) and `opts.mainMissing` makes the `refs/heads/main` rev-parse
   * reject so the HEAD fallback is exercised.
   */
  function makeExeca(opts: { worktreeExists?: boolean; mainMissing?: boolean } = {}) {
    const calls: ExecaCall[] = [];
    const impl = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse') {
        if (args.includes('refs/heads/main')) {
          if (opts.mainMissing) throw new Error('fatal: Needed a single revision');
          return { stdout: sha };
        }
        // HEAD fallback
        return { stdout: sha };
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: opts.worktreeExists ? `worktree ${expectedWtPath}\ndetached\n` : '' };
      }
      // worktree add / reset / prune / pnpm install — succeed silently.
      return { stdout: '' };
    });
    return { impl: impl as unknown as typeof import('execa').execa, calls };
  }

  beforeEach(() => {
    nodeModulesPresent = false;
  });

  it('(a) fresh creation: runs `git worktree add --detach` and returns the worktree path', async () => {
    const { impl, calls } = makeExeca({ worktreeExists: false });
    const result = await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    expect(result).toBe(expectedWtPath);
    const add = calls.find((c) => c.cmd === 'git' && c.args[1] === 'add');
    expect(add).toBeDefined();
    expect(add?.args).toContain('--detach');
    expect(add?.args).toContain(expectedWtPath);
    expect(add?.args).toContain(sha);
    // No reset on the create path.
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'reset')).toBe(false);
  });

  it('(b) reuse: skips `worktree add`, runs `git reset --hard <sha>`', async () => {
    const { impl, calls } = makeExeca({ worktreeExists: true });
    const result = await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    expect(result).toBe(expectedWtPath);
    expect(calls.some((c) => c.cmd === 'git' && c.args[1] === 'add')).toBe(false);
    const reset = calls.find((c) => c.cmd === 'git' && c.args[0] === 'reset');
    expect(reset).toBeDefined();
    expect(reset?.args).toEqual(['reset', '--hard', sha]);
  });

  it('(b2) does NOT false-match a different worktree whose path has the target as a prefix', async () => {
    // The porcelain list contains a sibling worktree `<wtPath>-bak`, which has
    // the target path as a string prefix. A substring-based existence check
    // would wrongly treat the target as already-registered and take the reuse
    // (reset) branch. The line-exact check must decide the target does NOT
    // exist and take the create (worktree add) branch.
    const calls: ExecaCall[] = [];
    const impl = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { stdout: sha };
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        // Only a sibling `<wtPath>-bak` is registered, NOT the target wtPath.
        // Use the forward-slash form git emits on the porcelain output.
        const bak = `${expectedWtPath.replace(/\\/g, '/')}-bak`;
        return { stdout: `worktree ${bak}\nHEAD ${sha}\ndetached\n` };
      }
      return { stdout: '' };
    }) as unknown as typeof import('execa').execa;

    const result = await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    expect(result).toBe(expectedWtPath);
    // Create branch taken: `worktree add --detach <wtPath> <sha>` ran...
    const add = calls.find((c) => c.cmd === 'git' && c.args[1] === 'add');
    expect(add).toBeDefined();
    expect(add?.args).toContain('--detach');
    expect(add?.args).toContain(expectedWtPath);
    expect(add?.args).toContain(sha);
    // ...and the reuse branch (reset --hard) was NOT taken.
    expect(calls.some((c) => c.cmd === 'git' && c.args[0] === 'reset')).toBe(false);
  });

  it('(c) node_modules present: skips `pnpm install`', async () => {
    nodeModulesPresent = true;
    const { impl, calls } = makeExeca({ worktreeExists: true });
    await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    expect(calls.some((c) => c.cmd === 'pnpm')).toBe(false);
  });

  it('(c2) node_modules absent: runs `pnpm install --frozen-lockfile`', async () => {
    nodeModulesPresent = false;
    const { impl, calls } = makeExeca({ worktreeExists: true });
    await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    const install = calls.find((c) => c.cmd === 'pnpm');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('(c3) alwaysInstall: runs `pnpm install` even when node_modules is present', async () => {
    nodeModulesPresent = true;
    const { impl, calls } = makeExeca({ worktreeExists: true });
    await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl, alwaysInstall: true });
    const install = calls.find((c) => c.cmd === 'pnpm');
    expect(install).toBeDefined();
    expect(install?.args).toEqual(['install', '--frozen-lockfile']);
  });

  it('(d) main absent: falls back to `rev-parse --verify HEAD`', async () => {
    const { impl, calls } = makeExeca({ worktreeExists: false, mainMissing: true });
    const result = await ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    expect(result).toBe(expectedWtPath);
    // Both rev-parse calls happened: main (which threw) then HEAD.
    const revParses = calls.filter((c) => c.cmd === 'git' && c.args[0] === 'rev-parse');
    expect(revParses.some((c) => c.args.includes('refs/heads/main'))).toBe(true);
    expect(revParses.some((c) => c.args.includes('HEAD'))).toBe(true);
  });

  it('(e) concurrent calls de-dupe through the in-flight map', async () => {
    // A deferred execa: the first call to `rev-parse main` blocks until we
    // release it, so both ensurePreviewWorktree calls overlap. If the map
    // works, only ONE underlying execa pipeline runs and both callers get the
    // same promise/result.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let revParseMainCount = 0;
    const calls: ExecaCall[] = [];
    const impl = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('refs/heads/main')) {
        revParseMainCount++;
        await gate;
        return { stdout: sha };
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        return { stdout: '' };
      }
      return { stdout: '' };
    }) as unknown as typeof import('execa').execa;

    const p1 = ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    const p2 = ensurePreviewWorktree(repoPath, projectId, { execaImpl: impl });
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(expectedWtPath);
    expect(r2).toBe(expectedWtPath);
    // The expensive pipeline ran exactly once despite two concurrent callers.
    expect(revParseMainCount).toBe(1);
    expect(calls.filter((c) => c.cmd === 'git' && c.args[1] === 'add').length).toBe(1);
  });
});

describe('cleanupPreviewWorktree', () => {
  const repoPath = '/tmp/wisp-repo';
  const projectId = 'proj-wt-1';
  const wtBase = join(dirname(resolve(repoPath)), '.harness-worktrees');

  it('removes the preview worktree by default and the bootcheck worktree via dirName', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const impl = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: '' };
    }) as unknown as typeof import('execa').execa;

    await cleanupPreviewWorktree(repoPath, projectId, { execaImpl: impl });
    await cleanupPreviewWorktree(repoPath, projectId, {
      dirName: `bootcheck-${projectId}`,
      execaImpl: impl,
    });

    expect(calls[0]?.args).toEqual([
      'worktree',
      'remove',
      '--force',
      join(wtBase, `preview-${projectId}`),
    ]);
    expect(calls[1]?.args).toEqual([
      'worktree',
      'remove',
      '--force',
      join(wtBase, `bootcheck-${projectId}`),
    ]);
  });

  it('never throws when git fails (worktree was never created)', async () => {
    const impl = vi.fn(async () => {
      throw new Error('fatal: not a working tree');
    }) as unknown as typeof import('execa').execa;
    await expect(
      cleanupPreviewWorktree(repoPath, projectId, { execaImpl: impl }),
    ).resolves.toBeUndefined();
  });
});
