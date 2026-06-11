import { describe, it, expect, vi } from 'vitest';
import type { HarnessEvent, Plan, TaskNode } from '@wisp/schemas';
import { Walker, type BudgetConfig, type WalkerDeps } from '../walker.js';
import type { RunClaudeOpts } from '../subprocess.js';

/**
 * Dispatch-time skill injection: when a team role declares `skills` and the
 * runtime wires `renderSkillsSection`, the rendered section is appended to
 * the agent's SYSTEM prompt (not the task prompt). Best-effort contract:
 * no renderer / throwing renderer / empty section → base prompt unchanged.
 */

const BUDGET: BudgetConfig = { budgetMinutes: 60, budgetTurns: 1000, maxParallel: 1 };
const FILLER = 'x'.repeat(80);

function node(id: string, role: string): TaskNode {
  return { id, role, prompt: `do ${id}`, deps: [], successCriteria: {}, maxTurns: 5 };
}

function makePlan(skills: string[] | undefined): Plan {
  return {
    goal: 'g',
    team: {
      roles: [
        {
          role: 'developer',
          model: 'sonnet',
          allowedTools: ['Read', 'Edit'],
          systemPrompt: `dev ${FILLER}`,
          ...(skills ? { skills } : {}),
        },
      ],
    },
    nodes: [node('a', 'developer')],
    edges: [],
  };
}

function makeDeps(args: {
  spawns: Array<{ taskId: string; opts: RunClaudeOpts }>;
  renderSkillsSection?: WalkerDeps['renderSkillsSection'];
}): WalkerDeps {
  return {
    pool: {
      maxParallel: 1,
      run(o: RunClaudeOpts): AsyncIterable<HarnessEvent> {
        args.spawns.push({ taskId: o.taskId, opts: o });
        return (async function* () {
          yield {
            type: 'task.completed',
            payload: { taskId: o.taskId, outcome: 'pass', exitCode: 0 },
          } as HarnessEvent;
        })();
      },
    } as unknown as WalkerDeps['pool'],
    worktree: {
      add: async ({ branchName }) => `/fake/wt/${branchName.replace(/[^a-zA-Z0-9]+/g, '-')}`,
      remove: async () => {},
    },
    verify: async () => ({ pass: true, output: 'ok', failures: [] }),
    emit: () => {},
    onTaskState: async () => {},
    onRunState: async () => {},
    snapshot: async () => '/fake/snap.json',
    setTimeout: (cb, ms) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
    now: () => Date.now(),
    autoCommit: async () => 'a'.repeat(40),
    mergeBranches: async () => ({ ok: true }),
    interTaskPacingMs: 0,
    autoResumeRateLimit: true,
    renderSkillsSection: args.renderSkillsSection,
  };
}

describe('Walker — skill injection into the system prompt', () => {
  it('appends the rendered skills section to the system prompt', async () => {
    const spawns: Array<{ taskId: string; opts: RunClaudeOpts }> = [];
    const render = vi.fn(
      (names: string[]) => `## Skills\napply these\n\n### Skill: ${names.join(', ')}`,
    );
    const walker = new Walker(makeDeps({ spawns, renderSkillsSection: render }));
    const outcome = await walker.start({
      runId: 'r1',
      plan: makePlan(['builder-discipline', 'frontend-quality']),
      repoPath: '/fake/repo',
      budget: BUDGET,
    });
    expect(outcome).toBe('success');
    expect(render).toHaveBeenCalledWith(['builder-discipline', 'frontend-quality']);
    const sys = spawns[0]!.opts.systemPrompt;
    expect(sys).toContain(`dev ${FILLER}`);
    expect(sys).toContain('### Skill: builder-discipline, frontend-quality');
    // System prompt, not task prompt.
    expect(spawns[0]!.opts.prompt).not.toContain('### Skill:');
  });

  it('leaves the system prompt unchanged when the role has no skills', async () => {
    const spawns: Array<{ taskId: string; opts: RunClaudeOpts }> = [];
    const render = vi.fn(() => '## Skills\nshould not appear');
    const walker = new Walker(makeDeps({ spawns, renderSkillsSection: render }));
    await walker.start({ runId: 'r1', plan: makePlan(undefined), repoPath: '/r', budget: BUDGET });
    expect(render).not.toHaveBeenCalled();
    expect(spawns[0]!.opts.systemPrompt).toBe(`dev ${FILLER}`);
  });

  it('leaves the system prompt unchanged when no renderer is wired', async () => {
    const spawns: Array<{ taskId: string; opts: RunClaudeOpts }> = [];
    const walker = new Walker(makeDeps({ spawns }));
    await walker.start({
      runId: 'r1',
      plan: makePlan(['builder-discipline']),
      repoPath: '/r',
      budget: BUDGET,
    });
    expect(spawns[0]!.opts.systemPrompt).toBe(`dev ${FILLER}`);
  });

  it('dispatches with the base prompt when the renderer throws or returns blank', async () => {
    for (const renderer of [
      () => {
        throw new Error('registry exploded');
      },
      () => '   ',
    ] as Array<WalkerDeps['renderSkillsSection']>) {
      const spawns: Array<{ taskId: string; opts: RunClaudeOpts }> = [];
      const walker = new Walker(makeDeps({ spawns, renderSkillsSection: renderer }));
      const outcome = await walker.start({
        runId: 'r1',
        plan: makePlan(['builder-discipline']),
        repoPath: '/r',
        budget: BUDGET,
      });
      expect(outcome).toBe('success');
      expect(spawns[0]!.opts.systemPrompt).toBe(`dev ${FILLER}`);
    }
  });
});
