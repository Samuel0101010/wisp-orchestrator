import './setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-end-ish test: with HARNESS_SERVE_WEB=true, a GET / returns the built
 * dashboard-web index.html. Skips silently when the web dist isn't present
 * (typical in CI before `pnpm build`).
 *
 * NOTE: env.ts reads process.env at import time, so we must set the env var
 * before the env module is loaded. Top-level ESM imports are hoisted, so we
 * use dynamic import() inside beforeAll AFTER mutating the env.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDistIndex = path.resolve(here, '..', '..', '..', 'dashboard-web', 'dist', 'index.html');
const haveDist = fs.existsSync(webDistIndex);

describe.skipIf(!haveDist)('serve-web mode', () => {
  let app: FastifyInstance;
  let sqliteRef: { close(): void } | null = null;

  beforeAll(async () => {
    process.env.HARNESS_SERVE_WEB = '1';
    const dbMod = await import('../db/index.js');
    const migrateMod = await import('../db/migrate.js');
    migrateMod.runMigrations();
    sqliteRef = dbMod.sqlite;
    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    sqliteRef?.close();
    delete process.env.HARNESS_SERVE_WEB;
  });

  it('GET / returns index.html when HARNESS_SERVE_WEB=1', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.toLowerCase()).toContain('<!doctype html>');
    expect(body.toLowerCase()).toContain('wisp');
  });

  it('SPA fallback: an unknown UI route returns index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/abc/teams' });
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('<!doctype html>');
  });

  it('API routes still respond as JSON, not HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
  });

  it('unknown /api routes return JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/this-does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});
