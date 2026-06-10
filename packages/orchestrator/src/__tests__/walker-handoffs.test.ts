import { describe, it, expect } from 'vitest';
import type { HarnessEvent, Plan, Team, TaskNode } from '@wisp/schemas';
import { Walker, collectTransitiveDeps, type WalkerDeps } from '../walker.js';
import type { RunClaudeOpts } from '../subprocess.js';

/**
 * P3 — per-node handoff scoping.
 *
 * - `collectTransitiveDeps` walks the dep closure (BFS, deduped, excludes the
 *   node itself, cycle-safe).
 * - `WalkerDeps.handoffsForNode` resolves the "## Prior Handoffs" section per
 *   task attempt with that closure; its result lands in the composed prompt.
 * - Absent resolver → the global `handoffsSection` fallback is used.
 * - A throwing resolver → prompt without the section, task still runs.
 */

// ---------- plan helpers ----------

function makeTeam(): Team {
  return {
    roles: [
      { role: 'architect', model: 'opus', allowedTools: ['Read'], systemPrompt: 'arch sys' },
      { role: 'developer', model: 'sonnet', allowedTools: ['Read'], systemPrompt: 'dev sys' },
      { role: 'qa', model: 'sonnet', allowedTools: ['Read'], systemPrompt: 'qa sys' },
    ],
  };
}

function node(id: string, role: string, deps: string[] = []): TaskNode {
  return { id, role, prompt: `do ${id}`, deps, successCriteria: {}, maxTurns: 5 };
}

function makePlan(nodes: TaskNode[]): Plan {
  const edges = nodes.flatMap((n) => n.deps.map((d) => ({ from: d, to: n.id })));
  return { goal: 'g', team: makeTeam(), nodes, edges };
}

/** a → b,c → d diamond (d deps [b, c]; b and c both dep [a]). */
function diamondPlan(): Plan {
  return makePlan([
    node('a', 'architect'),
    node('b', 'developer', ['a']),
    node('c', 'qa', ['a']),
    node('d', 'developer', ['b', 'c']),
  ]);
}

// ---------- harness ----------

interface Harness {
  walker: Walker;
  spawns: Array<{ taskId: string; prompt: string }>;
  emitted: HarnessEvent[];
}

function makeHarness(args: {
  handoffsSection?: string;
  handoffsForNode?: WalkerDeps['handoffsForNode'];
}): Harness {
  const spawns: Array<{ taskId: string; prompt: string }> = [];
  const emitted: HarnessEvent[] = [];
  const deps: WalkerDeps = {
    pool: {
      get maxParallel() {
        return 99;
      },
      terminateAll() {
        /* no-op */
      },
      run(o: RunClaudeOpts): AsyncIterable<HarnessEvent> {
        spawns.push({ taskId: o.taskId, prompt: o.prompt });
        return (async function* () {
          yield {
            type: 'task.completed',
            payload: { taskId: o.taskId, outcome: 'pass', exitCode: 0 },
          };
        })();
      },
    } as unknown as WalkerDeps['pool'],
    worktree: {
      async add({ branchName }) {
        return `/fake/wt/${branchName.replace(/[^a-zA-Z0-9]+/g, '-')}`;
      },
      async remove() {
        /* no-op */
      },
    },
    verify: async () => ({ pass: true, output: 'ok', failures: [] }),
    emit: (ev) => {
      emitted.push(ev);
    },
    onTaskState: async () => {
      /* no-op */
    },
    onRunState: async () => {
      /* no-op */
    },
    snapshot: async () => '/fake/snap.json',
    setTimeout: () => () => undefined,
    now: () => 0,
    autoCommit: async () => 'a'.repeat(40),
    mergeBranches: async () => ({ ok: true }),
    interTaskPacingMs: 0,
    autoResumeRateLimit: true,
    handoffsSection: args.handoffsSection,
    handoffsForNode: args.handoffsForNode,
  };
  return { walker: new Walker(deps), spawns, emitted };
}

const BUDGET = { budgetMinutes: 60, budgetTurns: 1000, maxParallel: 1 };

// ---------- collectTransitiveDeps ----------

describe('collectTransitiveDeps', () => {
  it('walks a diamond DAG: dedupes the shared root, excludes the node itself', () => {
    const { taskIds, roles } = collectTransitiveDeps(diamondPlan(), 'd');
    // BFS from d's deps [b, c]; 'a' appears once despite two paths.
    expect(taskIds).toEqual(['b', 'c', 'a']);
    expect(taskIds).not.toContain('d');
    // Roles deduped in first-seen order (b=developer, c=qa, a=architect).
    expect(roles).toEqual(['developer', 'qa', 'architect']);
  });

  it('returns empty arrays for a root node without deps', () => {
    expect(collectTransitiveDeps(diamondPlan(), 'a')).toEqual({ taskIds: [], roles: [] });
  });

  it('is cycle-safe and never includes the start node', () => {
    const plan = makePlan([node('x', 'developer', ['y']), node('y', 'qa', ['x'])]);
    const { taskIds, roles } = collectTransitiveDeps(plan, 'x');
    expect(taskIds).toEqual(['y']);
    expect(roles).toEqual(['qa']);
  });

  it('skips unknown dep ids without throwing', () => {
    const plan = makePlan([node('a', 'architect'), node('b', 'developer', ['a', 'ghost'])]);
    const { taskIds } = collectTransitiveDeps(plan, 'b');
    expect(taskIds).toEqual(['a']);
  });
});

// ---------- handoffsForNode wiring ----------

describe('Walker — per-node handoffs (handoffsForNode)', () => {
  it('calls the resolver with the node + transitive dep ids/roles and injects the result into the prompt', async () => {
    const calls: Array<{ nodeId: string; depTaskIds: string[]; depRoles: string[] }> = [];
    const h = makeHarness({
      handoffsSection: '## Prior Handoffs\nGLOBAL-FALLBACK (must not appear)',
      handoffsForNode: async ({ node: n, depTaskIds, depRoles }) => {
        calls.push({ nodeId: n.id, depTaskIds, depRoles });
        return depTaskIds.length > 0
          ? `## Prior Handoffs\nscoped:${n.id}:${depTaskIds.join('+')}`
          : '';
      },
    });
    const outcome = await h.walker.start({
      runId: 'r-handoffs',
      plan: diamondPlan(),
      repoPath: '/fake/repo',
      budget: BUDGET,
    });
    expect(outcome).toBe('success');

    const byId = new Map(calls.map((c) => [c.nodeId, c]));
    expect(byId.get('d')).toEqual({
      nodeId: 'd',
      depTaskIds: ['b', 'c', 'a'],
      depRoles: ['developer', 'qa', 'architect'],
    });
    expect(byId.get('a')).toEqual({ nodeId: 'a', depTaskIds: [], depRoles: [] });

    const dSpawn = h.spawns.find((s) => s.taskId === 'd');
    expect(dSpawn?.prompt).toContain('scoped:d:b+c+a');
    expect(dSpawn?.prompt).not.toContain('GLOBAL-FALLBACK');
    // Empty resolver result → section omitted entirely.
    const aSpawn = h.spawns.find((s) => s.taskId === 'a');
    expect(aSpawn?.prompt).not.toContain('## Prior Handoffs');
  });

  it('falls back to the global handoffsSection when no resolver is wired', async () => {
    const h = makeHarness({ handoffsSection: '## Prior Handoffs\nGLOBAL-FALLBACK' });
    const outcome = await h.walker.start({
      runId: 'r-handoffs-fallback',
      plan: makePlan([node('a', 'architect')]),
      repoPath: '/fake/repo',
      budget: BUDGET,
    });
    expect(outcome).toBe('success');
    expect(h.spawns[0]?.prompt).toContain('GLOBAL-FALLBACK');
  });

  it('a throwing resolver yields a prompt without the section and the task still runs', async () => {
    const h = makeHarness({
      handoffsSection: '## Prior Handoffs\nGLOBAL-FALLBACK (must not appear)',
      handoffsForNode: () => {
        throw new Error('handoff store down');
      },
    });
    const outcome = await h.walker.start({
      runId: 'r-handoffs-throw',
      plan: makePlan([node('a', 'architect'), node('b', 'developer', ['a'])]),
      repoPath: '/fake/repo',
      budget: BUDGET,
    });
    expect(outcome).toBe('success');
    expect(h.spawns.map((s) => s.taskId)).toEqual(['a', 'b']);
    for (const s of h.spawns) {
      expect(s.prompt).not.toContain('## Prior Handoffs');
      expect(s.prompt).toContain(`do ${s.taskId}`);
    }
  });

  it('a rejecting async resolver is also swallowed (task completes)', async () => {
    const h = makeHarness({
      handoffsForNode: async () => {
        throw new Error('async boom');
      },
    });
    const outcome = await h.walker.start({
      runId: 'r-handoffs-reject',
      plan: makePlan([node('a', 'architect')]),
      repoPath: '/fake/repo',
      budget: BUDGET,
    });
    expect(outcome).toBe('success');
    expect(h.spawns[0]?.prompt).not.toContain('## Prior Handoffs');
  });
});
