import './setup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { plans, projects, teams } from '@wisp/schemas';
import type { HarnessEvent, Plan, Team } from '@wisp/schemas';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import { db, sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { replanOnQAFailure } from '../orchestrator/replan.js';
import type { Runner } from '../orchestrator/planner-runner.js';

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

const minimalPlan: Plan = {
  goal: 'g',
  team: {
    roles: [
      {
        role: 'developer',
        model: 'haiku',
        systemPrompt: 's',
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
      systemPrompt: 's',
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
});
