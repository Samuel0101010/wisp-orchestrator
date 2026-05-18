import './setup.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
} from '../orchestrator/preview-server.js';

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
    expect(fetchCall?.[0]).toBe('http://127.0.0.1:5175/');
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
    const listening = await listenLoopback((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('ok');
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
    expect(res.body).toBe('ok');
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
