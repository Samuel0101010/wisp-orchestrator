import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { promptBundles } from '@wisp/schemas';
import { buildApp } from '../app.js';
import { runMigrations } from '../db/migrate.js';
import { db, sqlite } from '../db/index.js';

async function seedBundle(cwd: string): Promise<string> {
  const bundleKey = randomUUID();
  await db
    .insert(promptBundles)
    .values({
      bundleKey,
      cwd,
      claudeSessionId: 'sess-1',
      systemPromptHash: 'sys-hash',
      allowedToolsHash: 'tools-hash',
      model: 'claude-opus-4-8',
      hitCount: 3,
      lastUsedAt: new Date(),
      createdAt: new Date(),
    })
    .run();
  return bundleKey;
}

describe('prompt-bundles routes', () => {
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

  it('GET lists seeded bundles', async () => {
    const key = await seedBundle(path.join(os.tmpdir(), `wisp-bundle-${randomUUID()}`));
    const r = await app.inject({ method: 'GET', url: '/api/prompt-bundles' });
    expect(r.statusCode).toBe(200);
    const rows = r.json();
    const mine = rows.find((b: { bundleKey: string }) => b.bundleKey === key);
    expect(mine).toBeTruthy();
    expect(mine.model).toBe('claude-opus-4-8');
    expect(mine.hitCount).toBe(3);
  });

  it('DELETE removes the row and its on-disk cwd', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-bundle-'));
    fs.writeFileSync(path.join(cwd, 'marker.txt'), 'x');
    const key = await seedBundle(cwd);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/prompt-bundles/${encodeURIComponent(key)}`,
    });
    expect(del.statusCode).toBe(204);
    expect(fs.existsSync(cwd)).toBe(false);

    const row = db.select().from(promptBundles).where(eq(promptBundles.bundleKey, key)).get();
    expect(row).toBeUndefined();
  });

  it('DELETE returns 404 for an unknown key', async () => {
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/prompt-bundles/${encodeURIComponent('does-not-exist')}`,
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe('not_found');
  });

  it('DELETE still succeeds (and deletes the row) when the cwd no longer exists on disk', async () => {
    const missingCwd = path.join(os.tmpdir(), `wisp-bundle-gone-${randomUUID()}`);
    expect(fs.existsSync(missingCwd)).toBe(false);
    const key = await seedBundle(missingCwd);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/prompt-bundles/${encodeURIComponent(key)}`,
    });
    expect(del.statusCode).toBe(204);

    const row = db.select().from(promptBundles).where(eq(promptBundles.bundleKey, key)).get();
    expect(row).toBeUndefined();
  });
});
