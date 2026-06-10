import './setup.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeProjectMemoryEntry, closeAllStores } from '@wisp/memory-mcp';
import {
  loadHandoffsForNode,
  loadHandoffsForProject,
  renderHandoffsSection,
} from '../orchestrator/handoff-loader.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'handoff-test-'));
});

afterEach(async () => {
  closeAllStores();
  await rm(dataDir, { recursive: true, force: true });
});

describe('handoff loader + renderer', () => {
  it('renders a markdown section from two seeded handoff rows', () => {
    const projectId = 'projA';
    writeProjectMemoryEntry({
      dataDir,
      projectId,
      key: 'handoff/architect/t1',
      value: JSON.stringify({
        taskId: 't1',
        role: 'architect',
        prompt: 'Design the auth module with refresh tokens and PKCE flow.',
        completedAt: new Date().toISOString(),
        status: 'done',
      }),
    });
    // Force a 1ms gap so updated_at differs (SQLite Date.now() resolution).
    const wait = Date.now() + 2;
    while (Date.now() < wait) {
      // busy-wait
    }
    writeProjectMemoryEntry({
      dataDir,
      projectId,
      key: 'handoff/developer/t2',
      value: JSON.stringify({
        taskId: 't2',
        role: 'developer',
        prompt: 'Implement the /login endpoint per the architect spec.',
        completedAt: new Date().toISOString(),
        status: 'done',
      }),
    });

    const handoffs = loadHandoffsForProject({ dataDir, projectId });
    expect(handoffs).toHaveLength(2);
    expect(handoffs.map((h) => h.role)).toEqual(['architect', 'developer']);

    const md = renderHandoffsSection(handoffs);
    expect(md).toContain('## Prior Handoffs');
    expect(md).toContain('**architect** (t1)');
    expect(md).toContain('**developer** (t2)');
    expect(md).toContain('refresh tokens');
  });

  it('renderHandoffsSection returns empty string when handoffs is empty', () => {
    expect(renderHandoffsSection([])).toBe('');
    const empty = loadHandoffsForProject({ dataDir, projectId: 'projEmpty' });
    expect(empty).toEqual([]);
    expect(renderHandoffsSection(empty)).toBe('');
  });

  it('ignores malformed handoff rows without throwing', () => {
    const projectId = 'projB';
    writeProjectMemoryEntry({
      dataDir,
      projectId,
      key: 'handoff/bad/t-bad',
      value: 'not-json',
    });
    writeProjectMemoryEntry({
      dataDir,
      projectId,
      key: 'handoff/architect/t1',
      value: JSON.stringify({
        taskId: 't1',
        role: 'architect',
        prompt: 'Good entry.',
      }),
    });
    const handoffs = loadHandoffsForProject({ dataDir, projectId });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.taskId).toBe('t1');
  });

  it('caps results at the configured limit (newest preserved)', () => {
    const projectId = 'projC';
    for (let i = 0; i < 20; i++) {
      writeProjectMemoryEntry({
        dataDir,
        projectId,
        key: `handoff/dev/t${i}`,
        value: JSON.stringify({
          taskId: `t${i}`,
          role: 'developer',
          prompt: `Task number ${i}.`,
        }),
      });
    }
    const capped = loadHandoffsForProject({ dataDir, projectId, limit: 5 });
    expect(capped).toHaveLength(5);
  });
});

describe('loadHandoffsForNode (per-node dep scoping)', () => {
  const seed = (projectId: string, taskId: string, role: string, gapMs = 0): void => {
    if (gapMs > 0) {
      // Force a small gap so SQLite updated_at differs (Date.now() resolution).
      const wait = Date.now() + gapMs;
      while (Date.now() < wait) {
        // busy-wait
      }
    }
    writeProjectMemoryEntry({
      dataDir,
      projectId,
      key: `handoff/${role}/${taskId}`,
      value: JSON.stringify({
        taskId,
        role,
        prompt: `Handoff from ${taskId} (${role}).`,
      }),
    });
  };

  it('filters by dep task id', () => {
    const projectId = 'nodeA';
    seed(projectId, 't1', 'architect');
    seed(projectId, 't2', 'developer');
    seed(projectId, 't3', 'qa');
    const hits = loadHandoffsForNode({
      dataDir,
      projectId,
      depTaskIds: ['t1'],
      depRoles: [],
    });
    expect(hits.map((h) => h.taskId)).toEqual(['t1']);
  });

  it('filters by dep role (taskId not in deps)', () => {
    const projectId = 'nodeB';
    seed(projectId, 't1', 'architect');
    seed(projectId, 't2', 'developer');
    const hits = loadHandoffsForNode({
      dataDir,
      projectId,
      depTaskIds: [],
      depRoles: ['developer'],
    });
    expect(hits.map((h) => h.taskId)).toEqual(['t2']);
    expect(hits[0]!.role).toBe('developer');
  });

  it('caps at 10 by default, keeping the most recent entries', () => {
    const projectId = 'nodeC';
    for (let i = 0; i < 15; i++) {
      seed(projectId, `t${i}`, 'developer', 2);
    }
    const hits = loadHandoffsForNode({
      dataDir,
      projectId,
      depTaskIds: [],
      depRoles: ['developer'],
    });
    expect(hits).toHaveLength(10);
    // Tail-slice → oldest 5 dropped, newest survive, oldest-first order kept.
    expect(hits[0]!.taskId).toBe('t5');
    expect(hits[9]!.taskId).toBe('t14');
  });

  it('returns empty for empty dep lists even when handoffs exist', () => {
    const projectId = 'nodeD';
    seed(projectId, 't1', 'architect');
    const hits = loadHandoffsForNode({
      dataDir,
      projectId,
      depTaskIds: [],
      depRoles: [],
    });
    expect(hits).toEqual([]);
    expect(renderHandoffsSection(hits)).toBe('');
  });
});
