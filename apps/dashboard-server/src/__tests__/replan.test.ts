import './setup.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { plans, projects, teams } from '@wisp/schemas';
import type { Plan, Team } from '@wisp/schemas';
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
  tasks: [
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
});
