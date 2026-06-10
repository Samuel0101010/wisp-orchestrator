import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { plans, projects, teams } from '@wisp/schemas';
import type { HarnessEvent, Plan, Team } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { replanOnQAFailure } from '../orchestrator/replan.js';
import { generatePlan, type Runner } from '../orchestrator/planner-runner.js';

// Partial mock: generatePlan is wrapped in a vi.fn that delegates to the real
// implementation by default. The Finding-4 test overrides it ONCE to simulate
// the race where the stored team changed between generatePlan's role
// validation and the re-stamp (user edits the team mid-run).
vi.mock('../orchestrator/planner-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orchestrator/planner-runner.js')>();
  return { ...actual, generatePlan: vi.fn(actual.generatePlan) };
});

/**
 * Unit tests for the QA-failure replanner. The audit (T1) flagged this as
 * a P0 gap — it's a core orchestrator feature (regenerate a corrected DAG
 * when QA fails) with zero coverage. These tests exercise the negative
 * paths: every "row not found" / "team invalid" → returns null.
 *
 * The success path (planner actually returns a valid plan) requires
 * mocking the file-write workflow inside generatePlan; the smoke + e2e
 * tests in tests/e2e/ already exercise that path indirectly when running
 * with WISP_MOCK_CLI=1.
 */

const failingRunner: Runner = () => {
  throw new Error('runner should not have been called on a null-return path');
};

// systemPrompt has a 40-char minimum in the plan schema; pad so safeParsePlan
// (run inside generatePlan) accepts the fake-written plan.json.
const PROMPT_FILLER = 'x'.repeat(64);

/**
 * In-process fake planner runner that writes a SCHEMA-VALID plan.json (with a
 * DRIFTED goal) into the planner's cwd, then completes — mirrors the
 * success-path fake runner in plans.test.ts. Lets us assert the goal re-stamp
 * without spawning a real subprocess. Note generatePlan re-validates the file
 * with safeParsePlan + validateDag, so this plan must satisfy both (40-char
 * systemPrompt minimum, an `edges` array, a connected DAG).
 */
function fakePlannerRunner(driftedGoal: string): Runner {
  return (opts: RunClaudeOpts): AsyncIterable<HarnessEvent> =>
    (async function* () {
      const plan: Plan = {
        goal: driftedGoal,
        team: {
          roles: [
            {
              role: 'developer',
              model: 'sonnet',
              systemPrompt: `dev ${PROMPT_FILLER}`,
              allowedTools: [],
            },
            { role: 'qa', model: 'sonnet', systemPrompt: `qa ${PROMPT_FILLER}`, allowedTools: [] },
          ],
        },
        nodes: [
          {
            id: 'd',
            role: 'developer',
            prompt: 'implement',
            deps: [],
            maxTurns: 10,
            successCriteria: { build: 'pnpm build' },
          },
          {
            id: 'q',
            role: 'qa',
            prompt: 'verify',
            deps: ['d'],
            maxTurns: 10,
            successCriteria: { test: 'pnpm test' },
          },
        ],
        edges: [{ from: 'd', to: 'q' }],
      };
      fs.writeFileSync(path.join(opts.cwd, 'plan.json'), JSON.stringify(plan, null, 2));
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } satisfies HarnessEvent;
    })();
}

/**
 * Fake planner runner that writes a SCHEMA-VALID plan whose only role
 * ('rogue-dev') does not exist in the stored team — exercises the
 * validatePlanRoles chokepoint inside generatePlan (corrective retry, then
 * the PlannerRoleError terminal outcome).
 */
function fakeRoguePlannerRunner(): Runner {
  return (opts: RunClaudeOpts): AsyncIterable<HarnessEvent> =>
    (async function* () {
      const plan: Plan = {
        goal: 'g',
        team: {
          roles: [
            {
              role: 'rogue-dev',
              model: 'sonnet',
              systemPrompt: `rogue ${PROMPT_FILLER}`,
              allowedTools: [],
            },
          ],
        },
        nodes: [
          {
            id: 'r1',
            role: 'rogue-dev',
            prompt: 'implement',
            deps: [],
            maxTurns: 10,
            successCriteria: { build: 'pnpm build' },
          },
        ],
        edges: [],
      };
      fs.writeFileSync(path.join(opts.cwd, 'plan.json'), JSON.stringify(plan, null, 2));
      yield {
        type: 'task.completed',
        payload: { taskId: opts.taskId, outcome: 'pass', exitCode: 0 },
      } satisfies HarnessEvent;
    })();
}

const minimalPlan: Plan = {
  goal: 'g',
  team: {
    roles: [
      {
        role: 'developer',
        model: 'haiku',
        // Must satisfy agentSpecSchema's 40-char minimum even though these
        // fixtures currently only feed never-parsed negative paths — a future
        // reuse on a parsing path must not pass for the wrong reason.
        systemPrompt: `minimal dev ${PROMPT_FILLER}`,
        allowedTools: [],
      },
    ],
  },
  // Plan schema uses `nodes`, not `tasks` — an earlier draft of this test
  // had the wrong shape and the tests passed for the wrong reason (Zod
  // parse failure inside replanOnQAFailure on the stored dagJson).
  nodes: [
    {
      id: 't1',
      role: 'developer',
      prompt: 'do the thing',
      deps: [],
      maxTurns: 10,
      successCriteria: {},
    },
  ],
};

const minimalTeam: Team = {
  roles: [
    {
      role: 'developer',
      model: 'haiku',
      // ≥40 chars — see the matching note on minimalPlan above.
      systemPrompt: `minimal dev ${PROMPT_FILLER}`,
      allowedTools: [],
    },
  ],
};

function insertProject(id: string, goal = 'g'): void {
  db.insert(projects).values({ id, name: 'p', goal, repoPath: '/tmp' }).run();
}
function insertPlan(id: string, projectId: string, parentPlanId: string | null = null): void {
  db.insert(plans)
    .values({
      id,
      projectId,
      dagJson: minimalPlan as unknown,
      status: 'locked',
      parentPlanId,
    })
    .run();
}
function insertTeam(projectId: string, team: unknown = minimalTeam): void {
  db.insert(teams)
    .values({ id: randomUUID(), projectId, rolesJson: team as unknown })
    .run();
}

describe('replanOnQAFailure (T1 — negative paths)', () => {
  beforeAll(() => {
    runMigrations();
  });
  afterAll(() => {
    sqlite.close();
  });

  it('returns null when the parent plan row is missing', async () => {
    const result = await replanOnQAFailure({
      parentPlanId: randomUUID(), // never inserted
      failedPlan: minimalPlan,
      failedTaskId: 't1',
      qaError: 'oops',
      runner: failingRunner,
    });
    expect(result).toBeNull();
  });

  it('returns null when the team row is missing for an existing project + plan', async () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    insertProject(projectId);
    insertPlan(planId, projectId);
    // Intentionally do NOT insert the team row.
    const result = await replanOnQAFailure({
      parentPlanId: planId,
      failedPlan: minimalPlan,
      failedTaskId: 't1',
      qaError: 'oops',
      runner: failingRunner,
    });
    expect(result).toBeNull();
  });

  it('returns null when the team rolesJson is malformed', async () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    insertProject(projectId);
    insertPlan(planId, projectId);
    // Garbage in rolesJson — safeParse will reject.
    insertTeam(projectId, { not: 'a team' });
    const result = await replanOnQAFailure({
      parentPlanId: planId,
      failedPlan: minimalPlan,
      failedTaskId: 't1',
      qaError: 'oops',
      runner: failingRunner,
    });
    expect(result).toBeNull();
  });

  // Success path: the fake planner writes a plan whose goal is a paraphrase
  // ("DRIFTED planner paraphrase"). The replanner MUST re-stamp it to the
  // project's authoritative goal verbatim, in BOTH the returned value and the
  // persisted dagJson — otherwise the walker feeds a drifted goal to agents.
  it('re-stamps the replanned plan goal to project.goal verbatim (returned + persisted)', async () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    const projectGoal = 'EXACT user-authored goal that must survive the QA replan';
    insertProject(projectId, projectGoal);
    insertPlan(planId, projectId);
    // The stored team must satisfy teamSchema (40-char systemPrompt minimum),
    // else replanOnQAFailure returns null before the runner is reached.
    const validTeam: Team = {
      roles: [
        {
          role: 'developer',
          model: 'sonnet',
          systemPrompt: `dev ${PROMPT_FILLER}`,
          allowedTools: [],
        },
        { role: 'qa', model: 'sonnet', systemPrompt: `qa ${PROMPT_FILLER}`, allowedTools: [] },
      ],
    };
    insertTeam(projectId, validTeam);

    const result = await replanOnQAFailure({
      parentPlanId: planId,
      failedPlan: minimalPlan,
      failedTaskId: 't1',
      qaError: 'oops',
      runner: fakePlannerRunner('DRIFTED planner paraphrase'),
    });

    expect(result).not.toBeNull();
    expect(result!.newPlan.goal).toBe(projectGoal);

    // The persisted dagJson must carry the same re-stamped goal.
    const persisted = db.select().from(plans).where(eq(plans.id, result!.newPlanId)).get();
    expect(persisted).toBeTruthy();
    expect((persisted!.dagJson as Plan).goal).toBe(projectGoal);
  });

  it('returns null when the replan output keeps using roles not in the stored team', async () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    insertProject(projectId);
    insertPlan(planId, projectId);
    const validTeam: Team = {
      roles: [
        {
          role: 'developer',
          model: 'sonnet',
          systemPrompt: `dev ${PROMPT_FILLER}`,
          allowedTools: [],
        },
        { role: 'qa', model: 'sonnet', systemPrompt: `qa ${PROMPT_FILLER}`, allowedTools: [] },
      ],
    };
    insertTeam(projectId, validTeam);

    const result = await replanOnQAFailure({
      parentPlanId: planId,
      failedPlan: minimalPlan,
      failedTaskId: 't1',
      qaError: 'oops',
      // Writes a 'rogue-dev' plan on every attempt → corrective retry also
      // fails → PlannerRoleError → walker terminal-fail contract (null).
      runner: fakeRoguePlannerRunner(),
    });
    expect(result).toBeNull();
  });

  // Finding-4 regression: a re-stamp miss is reachable when the stored team
  // changes between generatePlan's role validation and the re-stamp (user
  // edits the team between run start and QA failure). The replanner must NOT
  // throw out of the walker callback — it logs a warning and returns null
  // (the walker's terminal-fail contract).
  it('returns null (no throw) when a replanned role is missing from the stored team (re-stamp miss)', async () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    insertProject(projectId);
    insertPlan(planId, projectId);
    const validTeam: Team = {
      roles: [
        {
          role: 'developer',
          model: 'sonnet',
          systemPrompt: `dev ${PROMPT_FILLER}`,
          allowedTools: [],
        },
      ],
    };
    insertTeam(projectId, validTeam);

    // Simulate the race: generatePlan returns a success outcome whose plan was
    // validated against an OLDER team revision — its role no longer exists in
    // the stored team the re-stamp runs against.
    const stalePlan: Plan = {
      goal: 'g',
      team: {
        roles: [
          {
            role: 'legacy-dev',
            model: 'sonnet',
            systemPrompt: `legacy ${PROMPT_FILLER}`,
            allowedTools: [],
          },
        ],
      },
      nodes: [
        {
          id: 'l1',
          role: 'legacy-dev',
          prompt: 'implement',
          deps: [],
          maxTurns: 10,
          successCriteria: {},
        },
      ],
      edges: [],
    };
    vi.mocked(generatePlan).mockResolvedValueOnce({ attempts: 1, plan: stalePlan });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await replanOnQAFailure({
        parentPlanId: planId,
        failedPlan: minimalPlan,
        failedTaskId: 't1',
        qaError: 'oops',
        runner: failingRunner,
      });
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('replan-restamp-role-missing'));
    } finally {
      warnSpy.mockRestore();
    }

    // No child plan row was persisted.
    const children = db.select().from(plans).where(eq(plans.parentPlanId, planId)).all();
    expect(children).toHaveLength(0);
  });

  // The planner could paraphrase a role's model / prompt / tools in its
  // emitted team. The replan must re-stamp every role from the stored team
  // row — same contract as the POST plan route.
  it('re-stamps the replanned team config from the stored team (paraphrase ignored)', async () => {
    const projectId = randomUUID();
    const planId = randomUUID();
    insertProject(projectId);
    insertPlan(planId, projectId);
    // Stored config deliberately differs from what fakePlannerRunner emits
    // (developer: sonnet + `dev ...` prompt) in model and systemPrompt.
    const storedTeam: Team = {
      roles: [
        {
          role: 'developer',
          model: 'opus',
          systemPrompt: `STORED dev ${PROMPT_FILLER}`,
          allowedTools: ['Read'],
        },
        { role: 'qa', model: 'sonnet', systemPrompt: `qa ${PROMPT_FILLER}`, allowedTools: [] },
      ],
    };
    insertTeam(projectId, storedTeam);

    const result = await replanOnQAFailure({
      parentPlanId: planId,
      failedPlan: minimalPlan,
      failedTaskId: 't1',
      qaError: 'oops',
      runner: fakePlannerRunner('whatever goal'),
    });

    expect(result).not.toBeNull();
    const dev = result!.newPlan.team.roles.find((r) => r.role === 'developer');
    expect(dev).toBeDefined();
    expect(dev!.model).toBe('opus');
    expect(dev!.systemPrompt.startsWith('STORED dev ')).toBe(true);
    expect(dev!.allowedTools).toEqual(['Read']);

    // The persisted dagJson must carry the same re-stamped team.
    const persisted = db.select().from(plans).where(eq(plans.id, result!.newPlanId)).get();
    const persistedDev = (persisted!.dagJson as Plan).team.roles.find(
      (r) => r.role === 'developer',
    );
    expect(persistedDev!.model).toBe('opus');
  });
});
