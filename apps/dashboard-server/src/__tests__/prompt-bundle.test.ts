import './setup.js';
import { describe, expect, it, beforeAll, beforeEach } from 'vitest';
import {
  buildBundleKey,
  lookupBundle,
  upsertBundle,
  recordSessionId,
  evictStaleBundles,
} from '../cache/prompt-bundle.js';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { existsSync } from 'node:fs';

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM prompt_bundles').run();
});

describe('buildBundleKey', () => {
  it('is deterministic for the same inputs', () => {
    const k1 = buildBundleKey({
      systemPrompt: 'foo',
      allowedTools: ['Read', 'Edit'],
      model: 'haiku',
    });
    const k2 = buildBundleKey({
      systemPrompt: 'foo',
      allowedTools: ['Read', 'Edit'],
      model: 'haiku',
    });
    expect(k1).toBe(k2);
  });

  it('is order-independent on allowedTools', () => {
    const a = buildBundleKey({ systemPrompt: 'x', allowedTools: ['A', 'B'], model: 'haiku' });
    const b = buildBundleKey({ systemPrompt: 'x', allowedTools: ['B', 'A'], model: 'haiku' });
    expect(a).toBe(b);
  });

  it('changes when systemPrompt differs by one char', () => {
    const a = buildBundleKey({ systemPrompt: 'x', allowedTools: [], model: 'haiku' });
    const b = buildBundleKey({ systemPrompt: 'y', allowedTools: [], model: 'haiku' });
    expect(a).not.toBe(b);
  });

  it('changes when model differs', () => {
    const a = buildBundleKey({ systemPrompt: 'x', allowedTools: [], model: 'haiku' });
    const b = buildBundleKey({ systemPrompt: 'x', allowedTools: [], model: 'sonnet' });
    expect(a).not.toBe(b);
  });
});

describe('upsertBundle + lookupBundle', () => {
  it('creates a row + returns it from lookup', async () => {
    const key = buildBundleKey({ systemPrompt: 'x', allowedTools: [], model: 'haiku' });
    const bundle = await upsertBundle(key, { systemPrompt: 'x', allowedTools: [], model: 'haiku' });
    expect(existsSync(bundle.cwd)).toBe(true);
    const found = lookupBundle(key);
    expect(found?.bundleKey).toBe(key);
    expect(found?.cwd).toBe(bundle.cwd);
  });

  it('subsequent lookup increments hit_count', async () => {
    const key = buildBundleKey({ systemPrompt: 'y', allowedTools: [], model: 'haiku' });
    await upsertBundle(key, { systemPrompt: 'y', allowedTools: [], model: 'haiku' });
    lookupBundle(key);
    lookupBundle(key);
    const row = lookupBundle(key);
    expect(row?.hitCount).toBeGreaterThanOrEqual(2);
  });
});

describe('recordSessionId', () => {
  it('writes claudeSessionId on the row', async () => {
    const key = buildBundleKey({ systemPrompt: 'z', allowedTools: [], model: 'haiku' });
    await upsertBundle(key, { systemPrompt: 'z', allowedTools: [], model: 'haiku' });
    recordSessionId(key, 'sess-12345');
    const row = lookupBundle(key);
    expect(row?.claudeSessionId).toBe('sess-12345');
  });
});

describe('evictStaleBundles', () => {
  it('deletes bundles whose lastUsedAt is older than ttlMs', async () => {
    const key = buildBundleKey({ systemPrompt: 'old', allowedTools: [], model: 'haiku' });
    await upsertBundle(key, { systemPrompt: 'old', allowedTools: [], model: 'haiku' });
    sqlite
      .prepare('UPDATE prompt_bundles SET last_used_at = ? WHERE bundle_key = ?')
      .run(Date.now() - 8 * 24 * 60 * 60 * 1000, key);
    const stats = await evictStaleBundles(7 * 24 * 60 * 60 * 1000);
    expect(stats.deleted).toBe(1);
    expect(lookupBundle(key)).toBeUndefined();
  });

  it('keeps fresh bundles', async () => {
    const key = buildBundleKey({ systemPrompt: 'fresh', allowedTools: [], model: 'haiku' });
    await upsertBundle(key, { systemPrompt: 'fresh', allowedTools: [], model: 'haiku' });
    const stats = await evictStaleBundles(7 * 24 * 60 * 60 * 1000);
    expect(stats.deleted).toBe(0);
    expect(lookupBundle(key)).toBeDefined();
  });
});
