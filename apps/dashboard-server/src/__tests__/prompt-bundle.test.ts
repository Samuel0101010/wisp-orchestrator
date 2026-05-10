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
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentTurn } from '../routes/chat-engine.js';
import { invokeSkill } from '../skills/invoker.js';
import { SkillRegistry } from '../skills/registry.js';

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

describe('runAgentTurn with bundleKey', () => {
  it('captures sessionId and writes it back to the bundle', async () => {
    const key = buildBundleKey({ systemPrompt: 'capture-test', allowedTools: [], model: 'haiku' });
    const { cwd } = await upsertBundle(key, {
      systemPrompt: 'capture-test',
      allowedTools: [],
      model: 'haiku',
    });
    async function* mockRunner(opts: { taskId: string }) {
      yield {
        type: 'task.session-id',
        payload: { taskId: opts.taskId, sessionId: 'sess-abc' },
      } as const;
      yield {
        type: 'task.text-delta',
        payload: { taskId: opts.taskId, text: 'hi' },
      } as const;
      yield {
        type: 'task.usage',
        payload: { taskId: opts.taskId, tokensIn: 1, tokensOut: 1, turns: 1 },
      } as const;
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } as const;
    }
    await runAgentTurn({
      systemPrompt: 'capture-test',
      prompt: '',
      allowedTools: [],
      model: 'haiku',
      taskId: 't',
      runner: mockRunner as any,
      cwd,
      bundleKey: key,
    });
    const row = lookupBundle(key);
    expect(row?.claudeSessionId).toBe('sess-abc');
  });

  it('does NOT delete cwd when isStableCwd', async () => {
    const key = buildBundleKey({ systemPrompt: 'no-delete', allowedTools: [], model: 'haiku' });
    const { cwd } = await upsertBundle(key, {
      systemPrompt: 'no-delete',
      allowedTools: [],
      model: 'haiku',
    });
    async function* mockRunner(opts: { taskId: string }) {
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } as const;
    }
    await runAgentTurn({
      systemPrompt: 'no-delete',
      prompt: '',
      allowedTools: [],
      model: 'haiku',
      taskId: 't',
      runner: mockRunner as any,
      cwd,
    });
    expect(existsSync(cwd)).toBe(true);
  });
});

describe('invokeSkill bundle reuse', () => {
  it('passes the same cwd to a second call with identical inputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-bundle-'));
    mkdirSync(join(root, 'echo'), { recursive: true });
    writeFileSync(
      join(root, 'echo/SKILL.md'),
      `---
name: echo
description: Bundle test skill
model: haiku
allowed-tools: ["Read"]
---
echo body`,
    );
    const reg = new SkillRegistry(root);
    reg.init();
    const seenCwds: string[] = [];
    async function* mockRunner(opts: any) {
      seenCwds.push(opts.cwd);
      yield {
        type: 'task.session-id',
        payload: { taskId: opts.taskId, sessionId: 'sess-1' },
      } as const;
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } as const;
    }
    await invokeSkill({ registry: reg, name: 'echo', args: 'a', runner: mockRunner as any });
    await invokeSkill({ registry: reg, name: 'echo', args: 'b', runner: mockRunner as any });
    expect(seenCwds[0]).toBe(seenCwds[1]);
  });
});
