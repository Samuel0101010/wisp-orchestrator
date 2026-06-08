import { describe, it, expect, vi } from 'vitest';
import { Walker } from '../walker.js';
import type { Plan } from '@wisp/schemas';

function makeFakeDeps() {
  const calls: Array<{ branchName: string; baseBranch?: string }> = [];
  // Captures the composed prompt passed to each subprocess launch so tests can
  // assert what the agent actually receives (e.g. the injected brief context).
  const prompts: string[] = [];
  return {
    calls,
    prompts,
    deps: {
      pool: {
        run: (opts: { prompt: string }) => {
          prompts.push(opts.prompt);
          return (async function* () {
            yield {
              type: 'task.completed' as const,
              payload: { taskId: 'x', outcome: 'pass' as const, exitCode: 0 },
            };
          })();
        },
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
      interTaskPacingMs: 0,
      autoResumeRateLimit: false,
      // Pre-rendered "## Project context" brief block; tests override this to
      // assert it threads through to the composed agent prompt.
      briefContext: undefined as string | undefined,
    },
  };
}

const linearPlan: Plan = {
  goal: 'g',
  team: {
    roles: [
      { role: 'architect', model: 'opus', allowedTools: [], systemPrompt: 'a'.repeat(60) },
      { role: 'developer', model: 'sonnet', allowedTools: [], systemPrompt: 'b'.repeat(60) },
      { role: 'qa', model: 'sonnet', allowedTools: [], systemPrompt: 'c'.repeat(60) },
    ],
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
      { branchName: 'wisp/r1/a', baseBranch: undefined },
      { branchName: 'wisp/r1/d', baseBranch: 'wisp/r1/a' },
      { branchName: 'wisp/r1/q', baseBranch: 'wisp/r1/d' },
      { branchName: 'wisp/r1/result', baseBranch: undefined },
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
    // q has deps ['b1', 'b2']. baseBranch should be wisp/rdiamond/b1; mergeBranches called with ['wisp/rdiamond/b2'].
    expect(deps.mergeBranches).toHaveBeenCalledWith(expect.any(String), ['wisp/rdiamond/b2']);
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
      'remove:/tmp/wisp-r2-a',
      'commit:d',
      'remove:/tmp/wisp-r2-d',
      'commit:q',
      'remove:/tmp/wisp-r2-q',
      'remove:/tmp/wisp-r2-result',
    ]);
  });

  it('on success, creates wisp/<runId>/result merging all leaf branches', async () => {
    const { deps } = makeFakeDeps();
    const walker = new Walker(deps as never);
    await walker.start({
      runId: 'r3',
      plan: linearPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 1 },
    });
    // Linear plan: only leaf is 'q'.
    expect(deps.worktree.add).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'wisp/r3/result' }),
    );
    expect(deps.mergeBranches).toHaveBeenLastCalledWith(expect.any(String), ['wisp/r3/q']);
  });

  it('diamond plan: result branch merges both leaf branches', async () => {
    const twoLeafPlan: Plan = {
      goal: 'g',
      team: linearPlan.team,
      nodes: [
        { id: 'a', role: 'architect', prompt: 'p', deps: [], successCriteria: {}, maxTurns: 5 },
        { id: 'l1', role: 'developer', prompt: 'p', deps: ['a'], successCriteria: {}, maxTurns: 5 },
        { id: 'l2', role: 'qa', prompt: 'p', deps: ['a'], successCriteria: {}, maxTurns: 5 },
      ],
      edges: [
        { from: 'a', to: 'l1' },
        { from: 'a', to: 'l2' },
      ],
    };
    const { deps } = makeFakeDeps();
    const walker = new Walker(deps as never);
    await walker.start({
      runId: 'r4',
      plan: twoLeafPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 2 },
    });
    expect(deps.mergeBranches).toHaveBeenLastCalledWith(expect.any(String), [
      'wisp/r4/l1',
      'wisp/r4/l2',
    ]);
  });
});

describe('walker — brief context threading', () => {
  it('passes deps.briefContext through to the composed agent prompt at dispatch', async () => {
    const { deps, prompts } = makeFakeDeps();
    // The runtime builds this block via buildBriefSummaryForAgents and sets it
    // on WalkerDeps; here we assert it actually reaches composeTaskPrompt at the
    // dispatch call site (guards against a future refactor dropping the arg).
    deps.briefContext = '## Project context\n\nPlatform: web\nTarget audience: indie devs';
    const walker = new Walker(deps as never);
    await walker.start({
      runId: 'rbrief',
      plan: linearPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 1 },
    });
    // Every dispatched task prompt must carry the brief section + a field value.
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) {
      expect(p).toContain('## Project context');
      expect(p).toContain('Platform: web');
    }
  });
});

describe('walker — unreachable downstream cancellation', () => {
  it('cancels pending tasks whose deps failed terminally and finalizes', async () => {
    const { deps } = makeFakeDeps();
    // Make verify return pass=false so every task fails after the single retry.
    deps.verify = vi.fn(async () => ({
      pass: false,
      output: 'verify failed',
      failures: [
        {
          kind: 'custom' as const,
          cmd: 'fake',
          exitCode: 1,
          tail: 'verify failed',
        },
      ],
    }));
    const walker = new Walker(deps as never);
    const outcome = await walker.start({
      runId: 'rfail',
      plan: linearPlan,
      repoPath: '/tmp/repo',
      budget: { budgetMinutes: 10, budgetTurns: 100, maxParallel: 1 },
    });
    // Linear plan: a fails on retry → walker must cancel d and q (deps blocked)
    // and finalize as 'failure' rather than hang.
    expect(outcome).toBe('failure');
    const taskFailedCalls = (deps.emit as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args[0])
      .filter((ev: { type: string }) => ev.type === 'task.failed');
    const cancelledMsgs = taskFailedCalls
      .map((ev: { payload: { error: string; taskId: string } }) => ev.payload)
      .filter((p: { error: string }) => p.error.includes('upstream dep failed'));
    expect(cancelledMsgs.length).toBe(2); // d and q
  });
});
