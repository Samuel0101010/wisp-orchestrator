import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agents, planSchema, plans, projects, teams, teamSchema, validateDag } from '@wisp/schemas';
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import { defaultRunner, type Runner } from '../orchestrator/planner-runner.js';
import { generateAndPersistPlan, safeTeamFromRow } from '../orchestrator/plan-generation.js';
import { normalizePlanIdentity } from '../orchestrator/plan-identity.js';

const UNBRIEFED_OVERRIDE_HEADER = 'x-allow-unbriefed';

/**
 * Parse the optional `changeRequestIds: string[]` field off the plan POST
 * body. Returns null when absent; an empty array when explicitly empty (the
 * caller wants "no change requests for this iteration"). zod is overkill
 * here — one optional field with element-level string validation.
 */
function parseChangeRequestIdsFromBody(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = (body as { changeRequestIds?: unknown }).changeRequestIds;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const cleaned: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.length > 0) cleaned.push(v);
  }
  return cleaned;
}

interface PlansRouterDeps {
  runner?: Runner;
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
          // No team configured yet. Return 200 + null so the client can treat
          // "fresh project" as a normal empty state instead of an error.
          return null;
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
          // Recency key is created_at (migration 0019); the id is a random
          // UUIDv4 and cannot order by time. id is a deterministic tiebreaker
          // for pre-migration rows (created_at backfilled to 0).
          .orderBy(desc(plans.createdAt), desc(plans.id))
          .get();
        if (!row) {
          // No plan generated yet. Return 200 + null so fresh projects don't
          // surface as console errors on Project Detail / Team Builder.
          return null;
        }
        return row;
      }),
    );

    app.post(
      '/api/projects/:projectId/plan',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);

        // Thin wrapper: the substantive pipeline (gates, context assembly,
        // planner invocation, injections, normalization, persistence) lives in
        // orchestrator/plan-generation.ts so the iterations endpoint can share
        // it. Status codes + payloads are unchanged.
        const outcome = await generateAndPersistPlan({
          projectId,
          runner,
          changeRequestIds: parseChangeRequestIdsFromBody(req.body),
          allowUnbriefed:
            (req.headers[UNBRIEFED_OVERRIDE_HEADER] as string | undefined)?.trim() === '1',
          persistStatus: 'draft',
        });

        if (!outcome.ok) {
          reply.code(outcome.status);
          return outcome.body;
        }

        reply.code(201);
        return {
          ...outcome.planRow,
          plan: outcome.plan,
          attempts: outcome.attempts,
          pendingChangeRequestIds: outcome.pendingChangeRequestIds,
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

        // Security chokepoint: the walker resolves agent specs from plan.team,
        // not the stored team row — so a PATCH body could smuggle an attacker-
        // chosen systemPrompt / model / allowedTools. Normalise every role to
        // the stored team spec (or the canonical system spec) before persisting.
        const teamRow = await db
          .select()
          .from(teams)
          .where(eq(teams.projectId, existing.projectId))
          .get();
        const storedTeam = teamRow ? safeTeamFromRow(teamRow.rolesJson) : null;
        if (!storedTeam) {
          reply.code(400);
          return {
            error: 'team_invalid',
            message: 'stored team is missing or malformed; please save the team again',
          };
        }
        const normalized = normalizePlanIdentity(parsed.data, storedTeam);
        if (!normalized.ok) {
          reply.code(422);
          return { error: 'plan_invalid_roles', invalidRoles: normalized.invalidRoles };
        }

        await db
          .update(plans)
          .set({ dagJson: normalized.plan as unknown })
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

        // Defense in depth: re-pin every role to the stored / canonical spec at
        // the lock boundary too, so a plan that reached the DB by any other
        // means (older PATCH, manual insert) can't carry rogue agent identities
        // into a run. The normalized dagJson is persisted alongside the lock.
        const teamRow = await db
          .select()
          .from(teams)
          .where(eq(teams.projectId, existing.projectId))
          .get();
        const storedTeam = teamRow ? safeTeamFromRow(teamRow.rolesJson) : null;
        if (!storedTeam) {
          reply.code(400);
          return {
            error: 'team_invalid',
            message: 'stored team is missing or malformed; please save the team again',
          };
        }
        const normalized = normalizePlanIdentity(parsed.data, storedTeam);
        if (!normalized.ok) {
          reply.code(422);
          return { error: 'plan_invalid_roles', invalidRoles: normalized.invalidRoles };
        }

        await db
          .update(plans)
          .set({ status: 'locked', dagJson: normalized.plan as unknown })
          .where(eq(plans.id, planId))
          .run();

        const updated = await db.select().from(plans).where(eq(plans.id, planId)).get();
        return updated ?? { ...existing, status: 'locked' };
      }),
    );
  };

  return router;
}

export const planRoutes: FastifyPluginAsync = createPlansRouter();
