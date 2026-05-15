import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store.js';
import { tools, findTool, type ScopeResolver } from '../tools.js';

async function withResolver<T>(
  fn: (resolve: ScopeResolver, store: MemoryStore) => Promise<T> | T,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-tools-'));
  const store = new MemoryStore(join(dir, 'mem.db'));
  const resolve: ScopeResolver = () => store;
  try {
    return await fn(resolve, store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('tools registry', () => {
  it('exposes exactly the four memory.* tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'memory.delete',
      'memory.get',
      'memory.list',
      'memory.set',
    ]);
  });

  it('memory.set writes and returns ok', async () => {
    await withResolver((resolve, s) => {
      const out = tools['memory.set'].handle(resolve, { key: 'a', value: 'one' });
      expect(out).toEqual({ ok: true });
      expect(s.get('a')).toBe('one');
    });
  });

  it('memory.get returns the stored value', async () => {
    await withResolver((resolve, s) => {
      s.set('a', 'one');
      expect(tools['memory.get'].handle(resolve, { key: 'a' })).toEqual({ value: 'one' });
    });
  });

  it('memory.get returns null for an unknown key', async () => {
    await withResolver((resolve) => {
      expect(tools['memory.get'].handle(resolve, { key: 'missing' })).toEqual({ value: null });
    });
  });

  it('memory.list returns sorted entries', async () => {
    await withResolver((resolve, s) => {
      s.set('b', 'second');
      s.set('a', 'first value');
      const out = tools['memory.list'].handle(resolve, {});
      expect(out).toEqual({
        entries: [
          { key: 'a', size: 11 },
          { key: 'b', size: 6 },
        ],
      });
    });
  });

  it('memory.delete returns deleted=true when a key existed and false otherwise', async () => {
    await withResolver((resolve, s) => {
      s.set('temp', 'x');
      expect(tools['memory.delete'].handle(resolve, { key: 'temp' })).toEqual({ deleted: true });
      expect(tools['memory.delete'].handle(resolve, { key: 'temp' })).toEqual({ deleted: false });
      expect(s.get('temp')).toBeNull();
    });
  });
});

describe('input schema validation', () => {
  it('memory.set rejects empty key', () => {
    const r = tools['memory.set'].inputSchema.safeParse({ key: '', value: 'x' });
    expect(r.success).toBe(false);
  });

  it('memory.get rejects missing key', () => {
    const r = tools['memory.get'].inputSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('memory.list accepts empty input', () => {
    const r = tools['memory.list'].inputSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('memory.delete rejects non-string key', () => {
    const r = tools['memory.delete'].inputSchema.safeParse({ key: 42 });
    expect(r.success).toBe(false);
  });

  it('memory.set accepts an explicit scope', () => {
    const r = tools['memory.set'].inputSchema.safeParse({
      key: 'k',
      value: 'v',
      scope: 'project',
    });
    expect(r.success).toBe(true);
  });

  it('memory.set rejects an unknown scope', () => {
    const r = tools['memory.set'].inputSchema.safeParse({
      key: 'k',
      value: 'v',
      scope: 'global',
    });
    expect(r.success).toBe(false);
  });
});

describe('findTool', () => {
  it('returns the entry for a known tool', () => {
    expect(findTool('memory.get')).toBeDefined();
  });

  it('returns null for an unknown tool', () => {
    expect(findTool('memory.purge')).toBeNull();
  });

  it('returns null for a prototype-pollution attempt (toString, hasOwnProperty)', () => {
    expect(findTool('toString')).toBeNull();
    expect(findTool('hasOwnProperty')).toBeNull();
    expect(findTool('__proto__')).toBeNull();
  });
});
