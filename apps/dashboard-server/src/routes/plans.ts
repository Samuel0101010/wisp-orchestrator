import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
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
} from '@wisp/schemas';
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
import {
  changeRequests as changeRequestsTable,
  dodCriteria as dodCriteriaTable,
  projectBriefs,
  type ChangeRequestStatus,
  type PlanKind,
} from '@wisp/schemas';
import { injectRuntimeVerifier } from '../orchestrator/inject-runtime-verifier.js';
import { injectLeadCheckpoint } from '../orchestrator/inject-lead-checkpoint.js';
import { injectWireUp } from '../orchestrator/inject-wire-up.js';
import { detectProjectType } from '../orchestrator/detect-project-type.js';
import { getLatestProjectState } from '../orchestrator/project-state-loader.js';

const UNBRIEFED_OVERRIDE_HEADER = 'x-allow-unbriefed';

const PENDING_STATUS: ChangeRequestStatus = 'pending';

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

/**
 * Load pending change_requests for an iteration plan. When `requestedIds`
 * is null → all pending requests for the project. When non-null →
 * filter to only those ids that ARE in the project AND in 'pending' status
 * (silently drops mismatches; the planner doesn't need to know about them).
 */
async function loadChangeRequestsForPlanning(
  projectId: string,
  requestedIds: string[] | null,
): Promise<Array<{ id: string; source: string; selector: string | null; userPrompt: string }>> {
  const rows = await db
    .select({
      id: changeRequestsTable.id,
      source: changeRequestsTable.source,
      selector: changeRequestsTable.selector,
      userPrompt: changeRequestsTable.userPrompt,
    })
    .from(changeRequestsTable)
    .where(
      and(
        eq(changeRequestsTable.projectId, projectId),
        eq(changeRequestsTable.status, PENDING_STATUS),
      ),
    )
    .all();
  if (requestedIds === null) return rows;
  const requestedSet = new Set(requestedIds);
  return rows.filter((r) => requestedSet.has(r.id));
}

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

        // v1.9 — gate plan-generation on briefReady unless the caller explicitly
        // opts out via the X-Allow-Unbriefed header (power-user / scripted use).
        // Manual sidebar + manager-chat create-project both auto-seed an empty
        // brief row, so the gate triggers consistently no matter the entry path.
        const brief = await db
          .select()
          .from(projectBriefs)
          .where(eq(projectBriefs.projectId, projectId))
          .get();
        const allowUnbriefed =
          (req.headers[UNBRIEFED_OVERRIDE_HEADER] as string | undefined)?.trim() === '1';
        if (!allowUnbriefed && (!brief || !brief.briefReady)) {
          reply.code(412);
          return {
            error: 'brief_not_ready',
            message:
              'Project brief is not finalised. Finish the interview at /api/projects/:id/interview or send header X-Allow-Unbriefed: 1 to override.',
            completenessScore: brief?.completenessScore ?? 0,
          };
        }

        // Substantive plan generation — gets full Thompson exploration. Orchestration
        // phases (context-ingest, status-post) should call pickFixed('haiku', 'planner-orchestration')
        // instead of consuming the same prior.
        const pick = pickModel('planner-substantive');

        const similar = await retrieveSimilar(project.goal, projectId, 3);
        const lastSummary = getLatestSummaryForProject(projectId);

        // v1.10 — plan kind detection. A pre-existing project_states row means
        // a prior run succeeded; treat this as an 'iteration' plan that gets
        // the latest state + any pending change_requests injected. Without a
        // state row this is the first plan ('initial', greenfield assumption).
        const latestState = await getLatestProjectState(db, projectId);
        const planKind: PlanKind = latestState ? 'iteration' : 'initial';
        const requestedChangeIds = parseChangeRequestIdsFromBody(req.body);
        const pendingChangeRequests =
          planKind === 'iteration'
            ? await loadChangeRequestsForPlanning(projectId, requestedChangeIds)
            : [];

        const sections: string[] = [];
        if (brief) {
          const briefLines: string[] = [];
          if (brief.targetAudience) briefLines.push(`Target audience: ${brief.targetAudience}`);
          if (brief.successCriteria) briefLines.push(`Success criteria: ${brief.successCriteria}`);
          if (brief.designPrefs) briefLines.push(`Design preferences: ${brief.designPrefs}`);
          if (brief.platform) briefLines.push(`Platform: ${brief.platform}`);
          if (brief.constraints) briefLines.push(`Constraints: ${brief.constraints}`);
          if (brief.deadline)
            briefLines.push(`Deadline: ${new Date(brief.deadline).toISOString().slice(0, 10)}`);
          if (briefLines.length > 0) {
            sections.push(
              `## Project brief (from requirements interview)\n\n` + briefLines.join('\n'),
            );
          }
        }
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
        if (latestState) {
          const stateLines: string[] = [
            `## Current project state (from prior run)\n`,
            `This is an ITERATION plan — the project already exists and runs. Plan a SURGICAL delta. Do not re-implement what is already shipped.`,
            '',
            `### Implemented features`,
            latestState.completedFeatures.length > 0
              ? latestState.completedFeatures.map((f) => `- ${f}`).join('\n')
              : '_(none recorded)_',
            '',
            `### Open todos`,
            latestState.openTodos.length > 0
              ? latestState.openTodos.map((t) => `- ${t}`).join('\n')
              : '_(none recorded)_',
            '',
            `### Known issues`,
            latestState.knownIssues.length > 0
              ? latestState.knownIssues.map((i) => `- ${i}`).join('\n')
              : '_(none recorded)_',
          ];
          sections.push(stateLines.join('\n'));
        }
        if (pendingChangeRequests.length > 0) {
          const crLines: string[] = [
            `## User change-requests to address THIS iteration\n`,
            ...pendingChangeRequests.map(
              (cr, i) =>
                `### CR-${i + 1} (id=${cr.id}, source=${cr.source}${cr.selector ? `, selector=${cr.selector}` : ''})\n${cr.userPrompt}`,
            ),
          ];
          sections.push(crLines.join('\n'));
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

        // v1.7.13 — splice a wire-up reconciliation node between the
        // parallel core-dev tasks and any downstream qa / runtime-verifier
        // nodes. Idempotent + non-destructive: skipped when no core-dev-
        // family roles are present in the plan (legacy library / refactor
        // plans pass through untouched) or when the 8-role cap is hit.
        // Runs BEFORE runtime-verifier injection so the verifier ends up
        // depending on wire-up.
        let finalPlan = outcome.plan;
        {
          const wireUpInjection = injectWireUp({ plan: finalPlan });
          finalPlan = wireUpInjection.plan;
        }

        // v1.8 — auto-inject the runtime-verifier node when the project opted
        // in. Idempotent + non-destructive: if the planner happened to include
        // it already, or the team is at the 8-role cap, the original plan
        // passes through unchanged. The release-gate degrades to legacy
        // behaviour in that case.
        if (project.runtimeVerifyEnabled) {
          const dod = await db
            .select()
            .from(dodCriteriaTable)
            .where(eq(dodCriteriaTable.projectId, projectId))
            .all();
          const detected = detectProjectType(project.repoPath);
          const injection = injectRuntimeVerifier({
            plan: finalPlan,
            dodCriteria: dod,
            detected: {
              type: detected.type,
              devCommand: detected.devCommand,
              probeUrl: detected.probeUrl,
            },
          });
          finalPlan = injection.plan;
        }

        // v2.0.0 Phase 8 — optionally add a lead-checkpoint node at the end
        // when the project has leadEnabled=true. Idempotent + non-destructive.
        if (project.leadEnabled) {
          const leadInjection = injectLeadCheckpoint({ plan: finalPlan });
          finalPlan = leadInjection.plan;
        }

        const id = randomUUID();
        const row = {
          id,
          projectId,
          dagJson: finalPlan as unknown,
          status: 'draft' as const,
          kind: planKind,
          parentStateId: latestState?.id ?? null,
        };
        await db.insert(plans).values(row).run();

        reply.code(201);
        return {
          ...row,
          plan: finalPlan,
          attempts: outcome.attempts,
          pendingChangeRequestIds: pendingChangeRequests.map((cr) => cr.id),
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
