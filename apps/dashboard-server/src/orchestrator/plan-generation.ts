import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  changeRequests as changeRequestsTable,
  dodCriteria as dodCriteriaTable,
  plans,
  projectBriefs,
  projects,
  teams,
  teamSchema,
  BUILDER_DISCIPLINE_SKILL,
  QA_VERIFICATION_SKILL,
  type ChangeRequestStatus,
  type Plan,
  type PlanKind,
  type Team,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import {
  generatePlan,
  isPlannerRoleError,
  isPlannerSuccess,
  isRateLimitOutcome,
  type Runner,
} from './planner-runner.js';
import { pickModel, recordOutcome } from '../router/thompson.js';
import { retrieveSimilar } from '../reasoningbank/store.js';
import { getLatestSummaryForProject } from '../run-summary/retrieve.js';
import { buildBriefContextSections } from './brief-context.js';
import { buildPlannerRepoSections, loadLatestPreviousPlan } from './planner-repo-context.js';
import { injectRuntimeVerifier } from './inject-runtime-verifier.js';
import { injectLeadCheckpoint } from './inject-lead-checkpoint.js';
import { injectWireUp } from './inject-wire-up.js';
import { detectProjectType } from './detect-project-type.js';
import { getLatestProjectState } from './project-state-loader.js';

/**
 * Plan generation + persistence (P2 Lane A extraction).
 *
 * This is the former body of POST /api/projects/:projectId/plan, lifted out
 * of routes/plans.ts so the new POST /api/projects/:projectId/iterations
 * endpoint can generate-and-persist a plan through the exact same pipeline
 * (gates, context assembly, injections, validation, normalization) without
 * going through HTTP. The route is now a thin wrapper around this function —
 * behavior (status codes + payloads) is unchanged.
 */

const PENDING_STATUS: ChangeRequestStatus = 'pending';

export function safeTeamFromRow(rolesJson: unknown): Team | null {
  // Validates a stored rolesJson row against the current Team schema.
  const direct = teamSchema.safeParse(rolesJson);
  if (direct.success) return direct.data;
  return null;
}

// Self-contained fallback team so a project created without a template (whose
// owner skipped the Team Builder) never dead-ends plan generation with
// team_missing. Persisted on first use so it's visible + editable afterwards.
const DEFAULT_PLAN_TEAM: Team = {
  roles: [
    {
      role: 'architect',
      model: 'opus',
      allowedTools: ['Read', 'Grep', 'Glob'],
      systemPrompt:
        'You are the architect. Break the goal into a small, buildable plan and define the interfaces the other roles implement against.',
    },
    {
      role: 'developer',
      model: 'sonnet',
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
      systemPrompt:
        'You are the developer. Implement the smallest correct slice that satisfies the plan, with clean, idiomatic, well-tested code.',
      skills: [BUILDER_DISCIPLINE_SKILL],
    },
    {
      role: 'qa',
      model: 'haiku',
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      systemPrompt:
        'You are QA. Verify the build, run the tests, and confirm the goal is actually met before the run is allowed to finish.',
      skills: [QA_VERIFICATION_SKILL],
    },
  ],
};

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

export interface GeneratedPlanRow {
  id: string;
  projectId: string;
  dagJson: unknown;
  status: 'draft' | 'locked';
  kind: PlanKind;
  parentStateId: string | null;
}

export type GenerateProjectPlanOutcome =
  | {
      ok: true;
      planRow: GeneratedPlanRow;
      plan: Plan;
      attempts: number;
      pendingChangeRequestIds: string[];
    }
  | { ok: false; status: 400 | 412 | 422 | 503; body: Record<string, unknown> };

export async function generateAndPersistPlan(args: {
  projectId: string;
  runner: Runner;
  /** null = no explicit selection (iteration plans consume ALL pending CRs). */
  changeRequestIds: string[] | null;
  /** Bypass the brief gate (X-Allow-Unbriefed header / iterations endpoint). */
  allowUnbriefed: boolean;
  persistStatus: 'draft' | 'locked';
}): Promise<GenerateProjectPlanOutcome> {
  const { projectId, runner, changeRequestIds } = args;

  const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return {
      ok: false,
      status: 400,
      body: { error: 'project_missing', message: 'project not found' },
    };
  }
  if (!project.goal || project.goal.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'goal_missing', message: 'project.goal is blank' },
    };
  }

  const teamRow = await db.select().from(teams).where(eq(teams.projectId, projectId)).get();
  let team: Team;
  if (!teamRow) {
    // Safety net (was a hard 400 team_missing): a project with no saved
    // team must not dead-end here. Seed + persist a sensible default so
    // completion is the path of least resistance; the user can still
    // customise it in the Team Builder afterwards.
    team = DEFAULT_PLAN_TEAM;
    await db.insert(teams).values({ id: randomUUID(), projectId, rolesJson: team }).run();
    console.log(JSON.stringify({ event: 'plan-gen-seeded-default-team', projectId }));
  } else {
    const parsed = safeTeamFromRow(teamRow.rolesJson);
    if (!parsed) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'team_invalid',
          message: 'stored team is malformed; please save the team again',
        },
      };
    }
    team = parsed;
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
  // Iterations consume project-state + change-requests, NOT the brief, so
  // a finalised brief is not a precondition for them. Without this, the
  // preview "Run Iteration" flow 412'd for any project created unbriefed
  // (chat generate_plan / sidebar) — even though it had a successful run
  // and project-state to iterate against.
  const isIteration = (changeRequestIds?.length ?? 0) > 0;
  const allowUnbriefed = isIteration || args.allowUnbriefed;
  if (!allowUnbriefed && (!brief || !brief.briefReady)) {
    return {
      ok: false,
      status: 412,
      body: {
        error: 'brief_not_ready',
        message:
          'Project brief is not finalised. Finish the interview at /api/projects/:id/interview or send header X-Allow-Unbriefed: 1 to override.',
        completenessScore: brief?.completenessScore ?? 0,
      },
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
  const pendingChangeRequests =
    planKind === 'iteration'
      ? await loadChangeRequestsForPlanning(projectId, changeRequestIds)
      : [];

  const sections: string[] = [];
  sections.push(...buildBriefContextSections(project.repoPath, brief));
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
  // P2 — incremental builds: when the repo already contains real code, feed
  // the planner a compact file tree + architecture.md + previous-plan digest
  // so it plans a delta on top of the existing app instead of re-scaffolding.
  // Applies to ALL plans (initial + iteration); scaffold-only repos add nothing.
  {
    const previousPlan = await loadLatestPreviousPlan(projectId);
    sections.push(...buildPlannerRepoSections({ repoPath: project.repoPath, previousPlan }));
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
    return {
      ok: false,
      status: 503,
      body: { error: 'rate-limit', resetAt: outcome.rateLimit.resetAt },
    };
  }

  if (isPlannerRoleError(outcome)) {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'plan_invalid_roles',
        attempts: outcome.attempts,
        invalidRoles: outcome.invalidRoles,
        allowedRoles: outcome.allowedRoles,
        message: outcome.error,
      },
    };
  }

  if (!isPlannerSuccess(outcome)) {
    return {
      ok: false,
      status: 422,
      body: {
        error: 'plan_generation_failed',
        attempts: outcome.attempts,
        message: outcome.error,
      },
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

  // Guarantee the run uses the team the user actually picked. The planner
  // is *instructed* to mirror the stored team, but a model could paraphrase
  // a role's model / prompt / allowedTools. Re-stamp each role from the
  // authoritative stored `team` (matched by role name) so the dispatched
  // agents are exactly what the template / Team Builder defined. Role names
  // are preserved, so node.role references stay valid; the system-role
  // injectors below then append wire-up / runtime-verifier / lead on top.
  // Re-stamp the goal too: plan.goal is the planner LLM's paraphrase, but
  // walker.composeTaskPrompt feeds plan.goal to every executing agent. Set
  // it to project.goal verbatim so what the user wrote — not a drifted
  // paraphrase — is what the crew builds against.
  // Strip node origins from planner output too: only the server-side
  // injectors below may stamp origin:'system', so a planner (or spoofed
  // plan.json) claiming a System badge is silently demoted.
  const byRole = new Map(team.roles.map((sr) => [sr.role, sr]));
  finalPlan = {
    ...finalPlan,
    goal: project.goal,
    nodes: finalPlan.nodes.map((n) => ({ ...n, origin: undefined })),
    team: {
      roles: finalPlan.team.roles.map((r) => {
        const sr = byRole.get(r.role);
        if (!sr) throw new Error(`unreachable: role '${r.role}' survived validatePlanRoles`);
        return sr;
      }),
    },
  };

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
  const row: GeneratedPlanRow = {
    id,
    projectId,
    dagJson: finalPlan as unknown,
    status: args.persistStatus,
    kind: planKind,
    parentStateId: latestState?.id ?? null,
  };
  await db.insert(plans).values(row).run();

  return {
    ok: true,
    planRow: row,
    plan: finalPlan,
    attempts: outcome.attempts,
    pendingChangeRequestIds: pendingChangeRequests.map((cr) => cr.id),
  };
}
