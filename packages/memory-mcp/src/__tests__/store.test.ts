import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../store.js';

async function withTmpDb<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mem-mcp-'));
  try {
    return await fn(join(dir, 'mem.db'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('MemoryStore', () => {
  it('set/get round-trip persists across re-open', async () => {
    await withTmpDb(async (path) => {
      {
        const s = new MemoryStore(path);
        s.set('arch.notes', 'use ESM imports');
        s.close();
      }
      {
        const s = new MemoryStore(path);
        try {
          expect(s.get('arch.notes')).toBe('use ESM imports');
        } finally {
          s.close();
        }
      }
    });
  });

  it('get returns null for an unknown key', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        expect(s.get('does.not.exist')).toBeNull();
      } finally {
        s.close();
      }
    });
  });

  it('list returns all keys with their value sizes, sorted', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        s.set('b.key', 'second');
        s.set('a.key', 'first value');
        s.set('c.key', 'three');
        const items = s.list();
        expect(items).toEqual([
          { key: 'a.key', size: 11 },
          { key: 'b.key', size: 6 },
          { key: 'c.key', size: 5 },
        ]);
      } finally {
        s.close();
      }
    });
  });

  it('list returns empty array on a fresh DB', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        expect(s.list()).toEqual([]);
      } finally {
        s.close();
      }
    });
  });

  it('delete returns true when a key existed and false otherwise', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        s.set('temp.key', 'x');
        expect(s.delete('temp.key')).toBe(true);
        expect(s.get('temp.key')).toBeNull();
        expect(s.delete('temp.key')).toBe(false); // already gone
      } finally {
        s.close();
      }
    });
  });

  it('set on an existing key overwrites the value (last write wins)', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        s.set('k', 'v1');
        s.set('k', 'v2');
        expect(s.get('k')).toBe('v2');
        // Only one row, not two.
        expect(s.list()).toHaveLength(1);
      } finally {
        s.close();
      }
    });
  });

  it('set/get tolerates UTF-8 multi-byte values', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        const value = 'Hä — 漢字 — 🚀';
        s.set('mb.key', value);
        expect(s.get('mb.key')).toBe(value);
      } finally {
        s.close();
      }
    });
  });

  it('creates the kv table on first open of a fresh DB', async () => {
    await withTmpDb(async (path) => {
      const s = new MemoryStore(path);
      try {
        // No throw means CREATE TABLE IF NOT EXISTS ran successfully.
        expect(s.list()).toEqual([]);
      } finally {
        s.close();
      }
    });
  });
});
