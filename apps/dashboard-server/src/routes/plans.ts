import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  planSchema,
  plans,
  projects,
  teams,
  teamSchema,
  validateDag,
  type Team,
} from '@agent-harness/schemas';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import {
  defaultRunner,
  generatePlan,
  isPlannerSuccess,
  isRateLimitOutcome,
  type Runner,
} from '../orchestrator/planner-runner.js';
import { pickModel, recordOutcome } from '../router/thompson.js';
import { retrieveSimilar } from '../reasoningbank/store.js';
import { getLatestSummaryForProject } from '../run-summary/retrieve.js';

interface PlansRouterDeps {
  runner?: Runner;
}

function safeTeamFromRow(rolesJson: unknown): Team | null {
  // Validates a stored rolesJson row against the current Team schema.
  const direct = teamSchema.safeParse(rolesJson);
  if (direct.success) return direct.data;
  return null;
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

        const team = teamSchema.parse(req.body);

        // Reject roles whose agentId points at a non-existent agent — without
        // this guard a client could plant an arbitrary UUID and the server
        // would silently accept it (later surfacing as a 404 from chat).
        const referencedAgentIds = team.roles
          .map((r) => r.agentId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (referencedAgentIds.length > 0) {
          const found = await db
            .select({ id: agents.id })
            .from(agents)
            .where(inArray(agents.id, referencedAgentIds))
            .all();
          const foundSet = new Set(found.map((r) => r.id));
          const missing = referencedAgentIds.filter((id) => !foundSet.has(id));
          if (missing.length > 0) {
            reply.code(400);
            return { error: 'unknown_agent_ids', agentIds: missing };
          }
        }

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

        // Substantive plan generation — gets full Thompson exploration. Orchestration
        // phases (context-ingest, status-post) should call pickFixed('haiku', 'planner-orchestration')
        // instead of consuming the same prior.
        const pick = pickModel('planner-substantive');

        const similar = await retrieveSimilar(project.goal, projectId, 3);
        const lastSummary = getLatestSummaryForProject(projectId);

        const sections: string[] = [];
        if (similar.length > 0) {
          sections.push(
            `## Context from past similar runs\n\n` +
              similar
                .map((t, i) => {
                  const lessonsLine = t.lessons ? `Lessons: ${t.lessons}\n` : '';
                  return `### Past run ${i + 1} (outcome: ${t.outcome}, similarity: ${t.score.toFixed(2)})\nGoal: ${t.prompt}\n${lessonsLine}`;
                })
                .join('\n'),
          );
        }
        if (lastSummary) {
          sections.push(`## Previous run on this project\n\n${lastSummary.summaryMd}`);
        }
        const context = sections.length > 0 ? sections.join('\n\n') : undefined;

        const outcome = await generatePlan(runner, team, project.goal, projectId, context);

        const succeeded = isPlannerSuccess(outcome);
        recordOutcome(pick.sampleId, succeeded ? 'success' : 'failure').catch((err) => {
          console.error('[router] recordOutcome failed', err);
        });

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
