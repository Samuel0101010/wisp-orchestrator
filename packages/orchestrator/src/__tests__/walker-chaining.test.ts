import { describe, it, expect, vi } from 'vitest';
import { Walker } from '../walker.js';
import type { Plan } from '@agent-harness/schemas';

function makeFakeDeps() {
  const calls: Array<{ branchName: string; baseBranch?: string }> = [];
  return {
    calls,
    deps: {
      pool: {
        run: () =>
          (async function* () {
            yield {
              type: 'task.completed' as const,
              payload: { taskId: 'x', outcome: 'pass' as const, exitCode: 0 },
            };
          })(),
        terminateAll: vi.fn(),
      } as never,
      worktree: {
        add: vi.fn(async (opts: { repoPath: string; branchName: string; baseBranch?: string }) => {
          calls.push({ branchName: opts.branchName, baseBranch: opts.baseBranch });
          return '/tmp/' + opts.branchName.replace(/\//g, '-');
        }),
        remove: vi.fn(async () => {}),
      },
      verify: vi.fn(async () => ({ pass: true, output: '', failures: [] })),
      emit: vi.fn(),
      onTaskState: vi.fn(async () => {}),
      onRunState: vi.fn(async () => {}),
      snapshot: vi.fn(async () => '/tmp/snap'),
      setTimeout: (cb: () => void, ms: number) => {
        const t = setTimeout(cb, ms);
        return () => clearTimeout(t);
      },
      now: () => Date.now(),
      autoCommit: vi.fn(async () => 'a'.repeat(40)),
      mergeBranches: vi.fn(async () => ({ ok: true as const })),
    },
  };
}

const linearPlan: Plan = {
  goal: 'g',
  team: {
    architect: {
      role: 'architect',
      model: 'opus',
      allowedTools: [],
      systemPrompt: 'a'.repeat(60),
    },
    developer: {
      role: 'developer',
      model: 'sonnet',
      allowedTools: [],
      systemPrompt: 'b'.repeat(60),
    },
    qa: {
      role: 'qa',
      model: 'sonnet',
      allowedTools: [],
      systemPrompt: 'c'.repeat(60),
    },
  },
  nodes: [
    { id: 'a', role: 'architect', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
    { id: 'd', role: 'developer', prompt: 'p', deps: ['a'], successCriteria: {}, maxTurns: 5 },
    { id: 'q', role: 'qa', prompt: 'p', deps: ['d'], successCriteria: {}, maxTurns: 5 },
  ],
  edges: [
    { from: 'a', to: 'd' },
    { from: 'd', to: 'q' },
  ],
};

const diamondPlan: Plan = {
  goal: 'g',
  team: linearPlan.team,
  nodes: [
    { id: 'a', role: 'architect', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
    { id: 'b1', role: 'developer', prompt: 'p', deps: ['a'], successCriteria: {}, maxTurns: 5 },
    { id: 'b2', role: 'developer', prompt: 'p', deps: ['a'], successCriteria: {}, maxTurns: 5 },
    { id: 'q', role: 'qa', prompt: 'p', deps: ['b1', 'b2'], successCriteria: {}, maxTurns: 5 },
  ],
  edges: [
    { from: 'a', to: 'b1' },
    { from: 'a', to: 'b2' },
    { from: 'b1', to: 'q' },
    { from: 'b2', to: 'q' },
  ],
};

describe('walker chaining', () => {
  it('chains downstream worktrees off the parent task branches', async () => {
    const { deps, calls } = makeFakeDeps();
    const walker = new Walker(deps as never);
    await walker.start({
      runId: 'r1',
      plan: linearPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 1 },
    });
    expect(calls).toEqual([
      { branchName: 'harness/r1/a', baseBranch: undefined },
      { branchName: 'harness/r1/d', baseBranch: 'harness/r1/a' },
      { branchName: 'harness/r1/q', baseBranch: 'harness/r1/d' },
    ]);
  });

  it('merges other dep branches into the diamond-leaf worktree', async () => {
    const { deps } = makeFakeDeps();
    const walker = new Walker(deps as never);
    await walker.start({
      runId: 'rdiamond',
      plan: diamondPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 2 },
    });
    // q has deps ['b1', 'b2']. baseBranch should be harness/rdiamond/b1; mergeBranches called with ['harness/rdiamond/b2'].
    expect(deps.mergeBranches).toHaveBeenCalledWith(
      expect.any(String),
      ['harness/rdiamond/b2'],
    );
  });

  it('calls autoCommit after subprocess success and before worktree.remove', async () => {
    const { deps } = makeFakeDeps();
    const order: string[] = [];
    deps.autoCommit = vi.fn(async (_path: string, taskId: string) => {
      order.push(`commit:${taskId}`);
      return 'a'.repeat(40);
    });
    deps.worktree.remove = vi.fn(async (opts: { worktreePath: string }) => {
      order.push(`remove:${opts.worktreePath}`);
    });
    const walker = new Walker(deps as never);
    await walker.start({
      runId: 'r2',
      plan: linearPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 1 },
    });
    expect(order).toEqual([
      'commit:a',
      'remove:/tmp/harness-r2-a',
      'commit:d',
      'remove:/tmp/harness-r2-d',
      'commit:q',
      'remove:/tmp/harness-r2-q',
    ]);
  });
});
