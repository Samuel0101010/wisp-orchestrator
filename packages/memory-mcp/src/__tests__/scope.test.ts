import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllStores, resolveProjectDbPath, resolveStore } from '../store.js';
import { readProjectMemoryEntries, writeProjectMemoryEntry } from '../project-store.js';

async function tmp(prefix = 'mem-scope-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

afterEach(() => {
  // The store cache is process-wide; close everything between tests so a
  // stale handle from the previous test can't surface "database is locked".
  closeAllStores();
});

describe('memory-mcp scope routing', () => {
  it('scope=project writes into a different DB than scope=run', async () => {
    const dir = await tmp();
    try {
      const runDbPath = join(dir, 'run.db');
      const projectId = 'proj1';
      const projDbPath = resolveProjectDbPath({ dataDir: dir, projectId });
      expect(projDbPath).not.toBe(runDbPath);

      const runStore = resolveStore({ scope: 'run', runDbPath });
      const projStore = resolveStore({ scope: 'project', dataDir: dir, projectId });

      runStore.set('handoff/run-only', 'r');
      projStore.set('handoff/project-only', 'p');

      // Each store sees only its own keys.
      expect(runStore.list().map((e) => e.key)).toEqual(['handoff/run-only']);
      expect(projStore.list().map((e) => e.key)).toEqual(['handoff/project-only']);

      // Cross-reading returns null.
      expect(runStore.get('handoff/project-only')).toBeNull();
      expect(projStore.get('handoff/run-only')).toBeNull();
    } finally {
      closeAllStores();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('project-scoped read-back works across closeAll cycles', async () => {
    const dir = await tmp();
    try {
      const projectId = 'proj2';
      writeProjectMemoryEntry({
        dataDir: dir,
        projectId,
        key: 'handoff/architect/t1',
        value: JSON.stringify({ taskId: 't1', role: 'architect' }),
      });
      const entries = readProjectMemoryEntries({ dataDir: dir, projectId });
      expect(entries.map((e) => e.key)).toEqual(['handoff/architect/t1']);
      const parsed = JSON.parse(entries[0]!.value);
      expect(parsed).toMatchObject({ taskId: 't1', role: 'architect' });
    } finally {
      closeAllStores();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('project DB persists across simulated run boundaries (run A → run B same project)', async () => {
    const dir = await tmp();
    try {
      const projectId = 'proj3';
      // Run A: open run DB at runA.db and write a project-scoped entry.
      {
        const runAPath = join(dir, 'runA.db');
        resolveStore({ scope: 'run', runDbPath: runAPath });
        const projA = resolveStore({ scope: 'project', dataDir: dir, projectId });
        projA.set('handoff/architect/t1', '{"taskId":"t1"}');
        closeAllStores();
      }
      // Run B: brand-new run DB; project-scoped store should still see the
      // entry from run A.
      {
        const runBPath = join(dir, 'runB.db');
        resolveStore({ scope: 'run', runDbPath: runBPath });
        const projB = resolveStore({ scope: 'project', dataDir: dir, projectId });
        expect(projB.get('handoff/architect/t1')).toBe('{"taskId":"t1"}');
      }
    } finally {
      closeAllStores();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolveStore({scope: project}) throws when projectId is missing', () => {
    expect(() => resolveStore({ scope: 'project', dataDir: '/tmp' })).toThrow(/HARNESS_PROJECT_ID/);
  });
});
