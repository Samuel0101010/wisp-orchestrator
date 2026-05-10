import './setup.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import Fastify from 'fastify';
import { createHooksRouter } from '../routes/hooks.js';

runMigrations();

describe('POST /api/hooks/event', () => {
  let originalToken: string | undefined;
  beforeEach(() => {
    originalToken = process.env.HARNESS_HOOK_TOKEN;
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.HARNESS_HOOK_TOKEN;
    else process.env.HARNESS_HOOK_TOKEN = originalToken;
  });

  it('rejects without token', async () => {
    process.env.HARNESS_HOOK_TOKEN = 's3cret';
    const app = Fastify({ logger: false });
    await app.register(createHooksRouter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/event',
      payload: { event: 'PreToolUse', toolName: 'Bash' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts with correct token and persists', async () => {
    process.env.HARNESS_HOOK_TOKEN = 's3cret';
    const app = Fastify({ logger: false });
    await app.register(createHooksRouter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/event',
      headers: { 'x-harness-token': 's3cret' },
      payload: { event: 'PreToolUse', toolName: 'Bash', payload: { command: 'ls' } },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('returns 503 when HARNESS_HOOK_TOKEN is unset', async () => {
    delete process.env.HARNESS_HOOK_TOKEN;
    const app = Fastify({ logger: false });
    await app.register(createHooksRouter);
    const res = await app.inject({
      method: 'POST',
      url: '/api/hooks/event',
      payload: { event: 'PreToolUse' },
    });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
