import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocketClient, { WebSocketServer, type RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { plans, projects, runs, teams } from '@wisp/schemas';
import { __resetWsState, publishToRun, publishToThread } from '../ws.js';
import { seedAgents } from '../db/agents-seed.js';
import { previewProcesses } from '../orchestrator/preview-server.js';
import { normalizeCloseCode } from '../routes/preview.js';

async function seedRun(): Promise<string> {
  const projectId = randomUUID();
  const planId = randomUUID();
  const runId = randomUUID();
  await db
    .insert(projects)
    .values({ id: projectId, name: 'p', goal: 'g', repoPath: '/tmp/r', createdAt: new Date() })
    .run();
  await db
    .insert(teams)
    .values({ id: randomUUID(), projectId, rolesJson: { roles: [] } })
    .run();
  await db
    .insert(plans)
    .values({ id: planId, projectId, dagJson: { tasks: [], edges: [] }, status: 'locked' })
    .run();
  await db
    .insert(runs)
    .values({
      id: runId,
      planId,
      status: 'pending',
      budgetMinutes: 60,
      budgetTurns: 100,
      maxParallel: 1,
    })
    .run();
  return runId;
}

/** Stand up a fake upstream vite-style WS server on an ephemeral port. */
async function startUpstreamWs(
  onConnection: (socket: WebSocketClient, protocol: string) => void,
  opts: {
    /**
     * Optional async handshake gate. When provided, the upstream defers the
     * WebSocket handshake (and thus the proxy-side `open` event) until the
     * supplied callback is invoked with `true`. Used to force the proxy's
     * client→upstream pending-buffer branch to run.
     */
    verifyClient?: (cb: (accept: boolean) => void) => void;
  } = {},
): Promise<{ wss: WebSocketServer; port: number }> {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: () => 'vite-hmr',
    ...(opts.verifyClient
      ? { verifyClient: (_info: unknown, cb: (accept: boolean) => void) => opts.verifyClient!(cb) }
      : {}),
  });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (socket) => onConnection(socket, socket.protocol));
  const addr = wss.address();
  if (typeof addr === 'string' || addr == null) throw new Error('upstream-listen-failed');
  return { wss, port: addr.port };
}

describe('preview HMR WebSocket proxy', () => {
  let app: FastifyInstance;
  let wsBaseUrl: string;
  let runId: string;
  let threadId: string;

  beforeAll(async () => {
    runMigrations();
    seedAgents();
    runId = await seedRun();
    app = await buildApp();
    await app.ready();
    const httpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    wsBaseUrl = httpBaseUrl.replace(/^http/, 'ws');

    // Seed a chat thread for the /ws/threads regression guard.
    const agentsRes = await app.inject({ method: 'GET', url: '/api/agents' });
    const managerId = (agentsRes.json() as Array<{ id: string; seedKey: string | null }>).find(
      (a) => a.seedKey === 'manager',
    )!.id;
    const tRes = await app.inject({
      method: 'POST',
      url: `/api/agents/${managerId}/threads`,
      payload: {},
    });
    threadId = (tRes.json() as { id: string }).id;
  });

  afterAll(async () => {
    previewProcesses.__test_reset();
    __resetWsState();
    await app.close();
    sqlite.close();
  });

  it('round-trips messages client↔upstream through the proxy and forwards vite-hmr', async () => {
    const projectId = `proj-ws-${randomUUID()}`;
    const upstreamReceived: string[] = [];
    let negotiatedProtocol = '';
    const upstream = await startUpstreamWs((socket, protocol) => {
      negotiatedProtocol = protocol;
      socket.on('message', (data: RawData) => {
        upstreamReceived.push(data.toString());
        // Reply so we can assert the upstream→client direction too.
        socket.send('upstream-pong');
      });
    });
    previewProcesses.__test_register({ projectId, port: upstream.port, pid: null });

    try {
      const client = new WebSocketClient(`${wsBaseUrl}/preview/${projectId}/`, ['vite-hmr']);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });

      const clientGot: string[] = [];
      client.on('message', (d: RawData) => clientGot.push(d.toString()));

      // client → upstream
      client.send('hello-upstream');
      // upstream → client (triggered by the upstream's pong above)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('no round-trip within 2s')), 2000);
        client.on('message', () => {
          if (clientGot.includes('upstream-pong')) {
            clearTimeout(t);
            resolve();
          }
        });
      });

      expect(upstreamReceived).toContain('hello-upstream');
      expect(clientGot).toContain('upstream-pong');
      // The proxy forwarded the browser's `vite-hmr` subprotocol upstream.
      expect(negotiatedProtocol).toBe('vite-hmr');

      client.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await new Promise<void>((resolve) => upstream.wss.close(() => resolve()));
    }
  });

  it('buffers client→upstream frames sent before upstream open and flushes them in order', async () => {
    const projectId = `proj-ws-buf-${randomUUID()}`;
    const upstreamReceived: string[] = [];
    // Hold the upstream handshake open until the test explicitly releases it.
    let releaseHandshake: (() => void) | null = null;
    const handshakeGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });

    const upstream = await startUpstreamWs(
      (socket) => {
        socket.on('message', (data: RawData) => {
          upstreamReceived.push(data.toString());
        });
      },
      {
        // Defer accepting the upstream handshake until `handshakeGate` resolves.
        // This delays the proxy-side `upstream.on('open')` past the moment the
        // browser client's early frames arrive, forcing the proxy to push them
        // into its `pending[]` buffer instead of sending immediately.
        verifyClient: (cb) => {
          void handshakeGate.then(() => cb(true));
        },
      },
    );
    previewProcesses.__test_register({ projectId, port: upstream.port, pid: null });

    try {
      const client = new WebSocketClient(`${wsBaseUrl}/preview/${projectId}/`, ['vite-hmr']);
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve());
        client.once('error', reject);
      });

      // The proxy↔upstream handshake is still gated here, so these frames MUST
      // be buffered by the proxy (the `pending[]` branch), not forwarded yet.
      client.send('early-1');
      client.send('early-2');
      client.send('early-3');

      // Give the proxy a tick to enqueue the buffered frames before we release
      // the upstream handshake. Nothing should have reached the upstream yet.
      await new Promise((r) => setTimeout(r, 80));
      expect(upstreamReceived).toEqual([]);

      // Release the gate → upstream `open` fires → proxy flushes `pending[]`.
      releaseHandshake!();

      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('buffered frames not flushed within 2s')),
          2000,
        );
        const poll = setInterval(() => {
          if (upstreamReceived.length >= 3) {
            clearTimeout(t);
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });

      // The buffered frames were flushed AND preserved their send order.
      expect(upstreamReceived).toEqual(['early-1', 'early-2', 'early-3']);

      // A post-open frame still goes straight through (non-buffered path).
      client.send('late-1');
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('post-open frame not forwarded within 2s')),
          2000,
        );
        const poll = setInterval(() => {
          if (upstreamReceived.includes('late-1')) {
            clearTimeout(t);
            clearInterval(poll);
            resolve();
          }
        }, 20);
      });
      expect(upstreamReceived).toEqual(['early-1', 'early-2', 'early-3', 'late-1']);

      client.close();
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      // Ensure the gate never leaks an unresolved promise if an assertion threw.
      releaseHandshake?.();
      await new Promise<void>((resolve) => upstream.wss.close(() => resolve()));
    }
  });

  describe('normalizeCloseCode', () => {
    it('maps reserved/abnormal codes (1005, 1006) to undefined', () => {
      expect(normalizeCloseCode(1005)).toBeUndefined();
      expect(normalizeCloseCode(1006)).toBeUndefined();
    });

    it('maps out-of-range codes to undefined', () => {
      expect(normalizeCloseCode(6000)).toBeUndefined();
      expect(normalizeCloseCode(999)).toBeUndefined();
    });

    it('passes a valid code (1011) through unchanged', () => {
      expect(normalizeCloseCode(1011)).toBe(1011);
    });

    it('returns undefined for a nullish/absent code', () => {
      expect(normalizeCloseCode(undefined)).toBeUndefined();
    });
  });

  it('closes the proxy WS promptly when the project is not running', async () => {
    const client = new WebSocketClient(`${wsBaseUrl}/preview/not-running-${randomUUID()}/`);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('socket did not close within 2s')), 2000);
      client.once('close', (code) => {
        clearTimeout(t);
        resolve(code);
      });
      client.once('error', () => {
        /* some ws versions surface the close as an error */
      });
    });
    expect(closeCode).toBe(1011);
  });

  // ---- Regression guard: adding the preview wsHandler must NOT break the
  // ---- core /ws/runs + /ws/threads routes registered in ws.ts.

  it('REGRESSION: /ws/runs still opens and delivers a published event', async () => {
    const client = new WebSocketClient(`${wsBaseUrl}/ws/runs/${runId}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    const messagePromise = new Promise<string>((resolve, reject) => {
      client.once('message', (data: RawData) => resolve(data.toString()));
      client.once('error', reject);
    });
    publishToRun(runId, { type: 'run.started', payload: { runId } });

    const parsed = JSON.parse(await messagePromise);
    expect(parsed.type).toBe('run.started');
    expect(parsed.payload.runId).toBe(runId);

    client.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('REGRESSION: /ws/threads still opens and delivers a published event', async () => {
    const client = new WebSocketClient(`${wsBaseUrl}/ws/threads/${threadId}`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    const got: Array<{ type: string; chunk?: string }> = [];
    client.on('message', (d: RawData) => got.push(JSON.parse(d.toString())));
    publishToThread(threadId, { type: 'chat.text-delta', threadId, chunk: 'regression-ok' });
    publishToThread(threadId, { type: 'chat.turn-complete', threadId });
    await new Promise((r) => setTimeout(r, 100));

    expect(got.some((e) => e.type === 'chat.text-delta' && e.chunk === 'regression-ok')).toBe(true);
    expect(got.some((e) => e.type === 'chat.turn-complete')).toBe(true);

    client.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('REGRESSION: /ws/runs/<unknown> still 404s on upgrade (preValidation path)', async () => {
    const client = new WebSocketClient(`${wsBaseUrl}/ws/runs/does-not-exist`);
    const status = await new Promise<number>((resolve, reject) => {
      client.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      client.once('open', () => reject(new Error('expected upgrade rejection, got open')));
      client.once('error', () => {
        /* some ws versions surface the 404 as an error */
      });
    });
    expect(status).toBe(404);
  });
});
