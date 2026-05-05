import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocketClient from 'ws';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';
import { __getRegistry, __resetWsState, publishToRun } from '../ws.js';

describe('websocket bus', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = address.replace(/^http/, 'ws');
  });

  afterAll(async () => {
    __resetWsState();
    await app.close();
    sqlite.close();
  });

  it('delivers a published event to a subscriber', async () => {
    const ws = new WebSocketClient(`${baseUrl}/ws/runs/abc`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    // wait a tick for the server-side socket to be registered
    await new Promise((r) => setTimeout(r, 50));
    expect(__getRegistry().get('abc')?.size).toBeGreaterThan(0);

    const messagePromise = new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()));
      ws.once('error', reject);
    });

    publishToRun('abc', {
      type: 'run.started',
      payload: { runId: 'abc' },
    });

    const received = await messagePromise;
    const parsed = JSON.parse(received);
    expect(parsed.type).toBe('run.started');
    expect(parsed.payload.runId).toBe('abc');

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('rejects invalid events', () => {
    expect(() =>
      publishToRun('abc', {
        // @ts-expect-error intentional invalid event
        type: 'nonsense',
        payload: {},
      }),
    ).toThrow();
  });
});
