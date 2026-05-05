import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  planSchema,
  plans,
  projects,
  safeParsePlan,
  teams,
  teamSchema,
  validateDag,
  type Plan,
  type Team,
} from '@agent-harness/schemas';
import { runClaude } from '@agent-harness/orchestrator';
import type { RunClaudeOpts } from '@agent-harness/orchestrator';
import type { HarnessEvent } from '@agent-harness/schemas';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { wrap } from './wrap.js';
import { publishToRun } from '../ws.js';
import { buildPlannerPrompt, plannerSpecFor } from '../orchestrator/planner.js';
import { makeMockRunner } from '../orchestrator/mock-runner.js';

type Runner = (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>;

interface PlansRouterDeps {
  runner?: Runner;
}

// TODO(M2/2.4): replace teamPutSchema with the new {roles:[...]} shape once
// the TeamBuilder UI sends the new format.
const teamPutSchema = teamSchema;

function safeTeamFromRow(rolesJson: unknown): Team | null {
  // TODO(M2/2.4): remove legacy slot-shape fallback once all stored rows are
  // in the new {roles:[...]} shape (migration 0002_variable_team.sql handles
  // existing rows on first boot).
  const direct = teamSchema.safeParse(rolesJson);
  if (direct.success) return direct.data;
  return null;
}

const MAX_ATTEMPTS = 3;
const PLANNER_MAX_TURNS = 20;

interface PlannerError {
  attempts: number;
  error: string;
}

interface PlannerSuccess {
  attempts: number;
  plan: Plan;
}

interface RateLimitOutcome {
  rateLimit: { resetAt: number | null };
}

type PlannerOutcome = PlannerSuccess | PlannerError | RateLimitOutcome;

function isRateLimitOutcome(o: PlannerOutcome): o is RateLimitOutcome {
  return (o as RateLimitOutcome).rateLimit !== undefined;
}

function isPlannerSuccess(o: PlannerOutcome): o is PlannerSuccess {
  return (o as PlannerSuccess).plan !== undefined;
}

async function runPlannerOnce(
  runner: Runner,
  cwd: string,
  prompt: string,
  team: Team,
  projectId: string,
): Promise<{ rateLimit: { resetAt: number | null } | null; failed: string | null }> {
  const spec = plannerSpecFor(team);
  // `planner-` prefix lets HARNESS_MOCK_CLI mode distinguish planner calls
  // from task calls (see apps/dashboard-server/src/orchestrator/mock-runner.ts).
  const taskId = `planner-${randomUUID()}`;
  const wsRunId = `planner:${projectId}`;
  const iter = runner({
    cwd,
    prompt,
    systemPrompt: spec.systemPrompt,
    allowedTools: spec.allowedTools,
    model: spec.model,
    maxTurns: PLANNER_MAX_TURNS,
    taskId,
  });

  let rateLimit: { resetAt: number | null } | null = null;
  let failedError: string | null = null;

  for await (const ev of iter) {
    // Planner-event asymmetry: events are broadcast via publishToRun for the
    // live UI feedback channel (`planner:<projectId>`), but they are NOT
    // persisted to the `events` table. Reason: the planner runs ad-hoc — it
    // has no parent `runs` row, and `events.runId` has a NOT NULL FK to runs.
    // If the planner fails, the structured error is in the HTTP response and
    // the server log; there is no DB-side audit trail. See architecture.md
    // "Extension points" → planner-event audit gap.
    try {
      publishToRun(wsRunId, ev);
    } catch {
      // ignore
    }
    if (ev.type === 'rate-limit.hit') {
      rateLimit = { resetAt: ev.payload.resetAt };
    }
    if (ev.type === 'task.failed' && !rateLimit) {
      failedError = ev.payload.error;
    }
  }

  return { rateLimit, failed: failedError };
}

async function generatePlan(
  runner: Runner,
  team: Team,
  goal: string,
  projectId: string,
): Promise<PlannerOutcome> {
  const cwd = mkdtempSync(path.join(env.HARNESS_DATA_DIR, 'planner-'));
  const planJsonPath = path.join(cwd, 'plan.json');
  const basePrompt = buildPlannerPrompt(goal, team);

  let lastError = '';
  let attempts = 0;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      const prompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\n## Retry\nYour previous attempt failed validation: ${lastError}; please regenerate.`;

      // Reset plan.json between attempts so a stale file doesn't shadow a failure.
      try {
        if (fs.existsSync(planJsonPath)) fs.unlinkSync(planJsonPath);
      } catch {
        // ignore
      }

      const { rateLimit, failed } = await runPlannerOnce(runner, cwd, prompt, team, projectId);
      if (rateLimit) {
        return { rateLimit };
      }

      if (failed) {
        lastError = `subprocess failed: ${failed}`;
        continue;
      }

      if (!fs.existsSync(planJsonPath)) {
        lastError = 'planner did not write plan.json';
        continue;
      }

      const raw = fs.readFileSync(planJsonPath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        lastError = `plan.json is not valid JSON: ${(err as Error).message}`;
        continue;
      }

      const safe = safeParsePlan(parsed);
      if (!safe.success) {
        lastError = `plan.json failed schema validation: ${safe.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`;
        continue;
      }

      const dag = validateDag(safe.data);
      if (!dag.ok) {
        lastError = `plan DAG invalid: ${dag.errors.join('; ')}`;
        continue;
      }

      return { plan: safe.data, attempts };
    }

    return { error: lastError || 'planner failed', attempts };
  } finally {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function defaultRunner(): Runner {
  if (env.HARNESS_MOCK_CLI) {
    return makeMockRunner();
  }
  return (opts: RunClaudeOpts) => runClaude(opts);
}

export function createPlansRouter(deps: PlansRouterDeps = {}): FastifyPluginAsync {
  const runner: Runner = deps.runner ?? defaultRunner();

  const router: FastifyPluginAsync = async (app) => {
    // ---------- Team CRUD ----------

    app.get(
      '/api/projects/:projectId/team',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);

        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const row = await db.select().from(teams).where(eq(teams.projectId, projectId)).get();
        if (!row) {
          reply.code(404);
          return { error: 'team not found' };
        }
        return safeTeamFromRow(row.rolesJson) ?? row.rolesJson;
      }),
    );

    app.put(
      '/api/projects/:projectId/team',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);

        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }

        const team = teamPutSchema.parse(req.body);
        // TODO(M2/2.4): slot-coherence checks removed; teamSchema superRefine
        // handles duplicate-role validation. Additional semantic checks live here.

        // Store the Team object directly. Physical column is TEXT-JSON
        // so the storage shape change is transparent.
        const existing = await db.select().from(teams).where(eq(teams.projectId, projectId)).get();

        if (existing) {
          await db.update(teams).set({ rolesJson: team }).where(eq(teams.id, existing.id)).run();
        } else {
          await db
            .insert(teams)
            .values({
              id: randomUUID(),
              projectId,
              rolesJson: team,
            })
            .run();
        }

        return team;
      }),
    );

    // ---------- Plans ----------

    app.get(
      '/api/projects/:projectId/plan',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);

        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const row = await db
          .select()
          .from(plans)
          .where(eq(plans.projectId, projectId))
          .orderBy(desc(plans.id))
          .get();
        if (!row) {
          reply.code(404);
          return { error: 'plan not found' };
        }
        return row;
      }),
    );

    app.post(
      '/api/projects/:projectId/plan',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);

        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(400);
          return { error: 'project_missing', message: 'project not found' };
        }
        if (!project.goal || project.goal.trim().length === 0) {
          reply.code(400);
          return { error: 'goal_missing', message: 'project.goal is blank' };
        }

        const teamRow = await db.select().from(teams).where(eq(teams.projectId, projectId)).get();
        if (!teamRow) {
          reply.code(400);
          return { error: 'team_missing', message: 'no team configured for this project' };
        }
        const team = safeTeamFromRow(teamRow.rolesJson);
        if (!team) {
          reply.code(400);
          return {
            error: 'team_invalid',
            message: 'stored team is malformed; please save the team again',
          };
        }

        const outcome = await generatePlan(runner, team, project.goal, projectId);

        if (isRateLimitOutcome(outcome)) {
          reply.code(503);
          return { error: 'rate-limit', resetAt: outcome.rateLimit.resetAt };
        }

        if (!isPlannerSuccess(outcome)) {
          reply.code(422);
          return {
            error: 'plan_generation_failed',
            attempts: outcome.attempts,
            message: outcome.error,
          };
        }

        const id = randomUUID();
        const row = {
          id,
          projectId,
          dagJson: outcome.plan as unknown,
          status: 'draft' as const,
        };
        await db.insert(plans).values(row).run();

        reply.code(201);
        return {
          ...row,
          plan: outcome.plan,
          attempts: outcome.attempts,
        };
      }),
    );

    // PATCH /api/plans/:planId — update the dag of a draft plan.
    app.patch(
      '/api/plans/:planId',
      wrap(async (req, reply) => {
        const { planId } = z.object({ planId: z.string().min(1) }).parse(req.params);

        const body = z
          .object({
            dagJson: z.unknown().optional(),
          })
          .parse(req.body ?? {});

        const existing = await db.select().from(plans).where(eq(plans.id, planId)).get();
        if (!existing) {
          reply.code(404);
          return { error: 'plan not found' };
        }
        if (existing.status !== 'draft') {
          reply.code(409);
          return { error: 'plan-locked', currentStatus: existing.status };
        }

        if (body.dagJson === undefined) {
          reply.code(400);
          return { error: 'empty-patch', message: 'PATCH body must include dagJson' };
        }

        const parsed = planSchema.safeParse(body.dagJson);
        if (!parsed.success) {
          reply.code(400);
          return {
            error: 'invalid_plan',
            errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          };
        }
        const dag = validateDag(parsed.data);
        if (!dag.ok) {
          reply.code(400);
          return { error: 'invalid_dag', errors: dag.errors };
        }

        await db
          .update(plans)
          .set({ dagJson: parsed.data as unknown })
          .where(eq(plans.id, planId))
          .run();

        const updated = await db.select().from(plans).where(eq(plans.id, planId)).get();
        return updated ?? existing;
      }),
    );

    // POST /api/plans/:planId/lock — transition draft → locked.
    app.post(
      '/api/plans/:planId/lock',
      wrap(async (req, reply) => {
        const { planId } = z.object({ planId: z.string().min(1) }).parse(req.params);

        const existing = await db.select().from(plans).where(eq(plans.id, planId)).get();
        if (!existing) {
          reply.code(404);
          return { error: 'plan not found' };
        }
        if (existing.status !== 'draft') {
          reply.code(409);
          return { error: 'invalid-transition', currentStatus: existing.status };
        }

        const parsed = planSchema.safeParse(existing.dagJson);
        if (!parsed.success) {
          reply.code(400);
          return {
            error: 'invalid_plan',
            errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          };
        }
        const dag = validateDag(parsed.data);
        if (!dag.ok) {
          reply.code(400);
          return { error: 'invalid_dag', errors: dag.errors };
        }

        await db.update(plans).set({ status: 'locked' }).where(eq(plans.id, planId)).run();

        const updated = await db.select().from(plans).where(eq(plans.id, planId)).get();
        return updated ?? { ...existing, status: 'locked' };
      }),
    );
  };

  return router;
}

export const planRoutes: FastifyPluginAsync = createPlansRouter();
