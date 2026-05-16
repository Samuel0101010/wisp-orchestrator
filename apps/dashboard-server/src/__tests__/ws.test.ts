import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocketClient from 'ws';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';
import { plans, projects, runs, teams } from '@wisp/schemas';
import { __getRegistry, __resetWsState, publishToRun } from '../ws.js';

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

describe('websocket bus', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let httpBaseUrl: string;
  let runId: string;

  beforeAll(async () => {
    runMigrations();
    runId = await seedRun();
    app = await buildApp();
    await app.ready();
    httpBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = httpBaseUrl.replace(/^http/, 'ws');
  });

  afterAll(async () => {
    __resetWsState();
    await app.close();
    sqlite.close();
  });

  it('delivers a published event to a subscriber', async () => {
    const ws = new WebSocketClient(`${baseUrl}/ws/runs/${runId}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    // wait a tick for the server-side socket to be registered
    await new Promise((r) => setTimeout(r, 50));
    expect(__getRegistry().get(runId)?.size).toBeGreaterThan(0);

    const messagePromise = new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()));
      ws.once('error', reject);
    });

    publishToRun(runId, {
      type: 'run.started',
      payload: { runId },
    });

    const received = await messagePromise;
    const parsed = JSON.parse(received);
    expect(parsed.type).toBe('run.started');
    expect(parsed.payload.runId).toBe(runId);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('rejects invalid events', () => {
    expect(() =>
      publishToRun(runId, {
        // @ts-expect-error intentional invalid event
        type: 'nonsense',
        payload: {},
      }),
    ).toThrow();
  });

  it('rejects upgrade with 404 for unknown run id', async () => {
    // The server returns 404 before completing the protocol switch, so the
    // ws client emits an 'unexpected-response' event rather than 'open'.
    const ws = new WebSocketClient(`${baseUrl}/ws/runs/does-not-exist`);
    const status = await new Promise<number>((resolve, reject) => {
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => reject(new Error('expected upgrade rejection, got open')));
      ws.once('error', () => {
        // Some ws client versions surface this as an error after the 404.
      });
    });
    expect(status).toBe(404);
  });
});
