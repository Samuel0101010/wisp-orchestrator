import './setup.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';
import { setLastAuthProbe } from '../auth-status.js';

describe('health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
  });

  afterEach(() => {
    setLastAuthProbe(null);
  });

  it('returns ok=true with authProbe=null when no probe has run', async () => {
    setLastAuthProbe(null);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.time).toBe('string');
    expect(body.version).toBe('0.1.0');
    expect(body.authProbe).toBeNull();
  });

  it('surfaces an ok auth probe', async () => {
    setLastAuthProbe({ ok: true, durationMs: 12 });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().authProbe).toEqual({ ok: true });
  });

  it('surfaces a failing auth probe with hint (no internal error)', async () => {
    setLastAuthProbe({
      ok: false,
      error: 'long internal stderr here',
      hint: 'Run `claude login` to refresh credentials.',
    });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const probe = res.json().authProbe;
    expect(probe.ok).toBe(false);
    expect(probe.hint).toMatch(/claude login/);
    // Internal error string should NOT leak to the client.
    expect(probe.error).toBeUndefined();
  });
});
