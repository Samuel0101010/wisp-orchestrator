import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  plans as plansTable,
  projectBriefs,
  projects,
  teams,
  teamSchema,
  type Plan as PlanShape,
  type Team,
} from '@wisp/schemas';
import { db } from '../db/index.js';
import {
  defaultRunner,
  generatePlan,
  isPlannerRoleError,
  isPlannerSuccess,
  isRateLimitOutcome,
  type Runner,
} from './planner-runner.js';
import { buildBriefContextSections } from './brief-context.js';
import { buildPlannerRepoSections, loadLatestPreviousPlan } from './planner-repo-context.js';
import { normalizePlanIdentity } from './plan-identity.js';

export interface ReplanArgs {
  parentPlanId: string;
  failedPlan: PlanShape;
  failedTaskId: string;
  qaError: string;
  /** Optional override; defaults to defaultRunner() (real CLI or mock based on env). */
  runner?: Runner;
}

export interface ReplanResult {
  newPlanId: string;
  newPlan: PlanShape;
}

const QA_ERROR_TAIL = 1500;

function truncateError(s: string): string {
  if (s.length <= QA_ERROR_TAIL) return s;
  return `${s.slice(0, 200)}\n[… ${s.length - 200 - QA_ERROR_TAIL + 1} chars omitted …]\n${s.slice(-QA_ERROR_TAIL)}`;
}

/**
 * Composes an "extended goal" for the replanner: the original goal plus the
 * QA failure context so the planner can produce a corrected DAG. Saves the
 * resulting plan with parent_plan_id pointing at the original.
 *
 * Returns null if the planner can't produce a valid plan (rate-limited, max
 * attempts exhausted, etc.). The walker treats null as "fall through to
 * task.failed".
 */
export async function replanOnQAFailure(args: ReplanArgs): Promise<ReplanResult | null> {
  // Fetch the team for the same project — replans share the team config.
  const parentRow = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.id, args.parentPlanId))
    .get();
  if (!parentRow) return null;

  const projectRow = await db
    .select()
    .from(projects)
    .where(eq(projects.id, parentRow.projectId))
    .get();
  if (!projectRow) return null;

  const teamRow = await db
    .select()
    .from(teams)
    .where(eq(teams.projectId, parentRow.projectId))
    .get();
  if (!teamRow) return null;
  // Validate rather than cast: a malformed rolesJson (schema drift, manual DB
  // edit) would otherwise blow up inside buildPlannerPrompt's roles.length /
  // roles.map calls, and the throw would propagate out of the walker callback
  // marking the whole run as failed with a cryptic stack instead of returning
  // null cleanly here.
  const teamParsed = teamSchema.safeParse(teamRow.rolesJson);
  if (!teamParsed.success) return null;
  const team: Team = teamParsed.data;

  // Compose the extended goal — preserve the original at the top, append QA's context.
  const originalGoal = projectRow.goal;
  const extendedGoal =
    `${originalGoal}\n\n` +
    `## QA-Replan Context\n` +
    `The previous plan's QA task '${args.failedTaskId}' verified-failed terminally. ` +
    `Please regenerate a corrected plan addressing this QA failure:\n\n` +
    truncateError(args.qaError);

  // Carry the brief/PRD context into the replan too — an automated QA-failure
  // replan must not lose the original requirements. Best-effort: no brief row →
  // no extra context (buildBriefContextSections returns []).
  const briefRow = await db
    .select()
    .from(projectBriefs)
    .where(eq(projectBriefs.projectId, parentRow.projectId))
    .get();
  const briefSections = buildBriefContextSections(projectRow.repoPath, briefRow);
  // P2 — incremental builds: a QA-replan must also see the existing codebase
  // (file tree, architecture.md, previous plan) so the corrected plan stays a
  // delta instead of re-scaffolding. previousPlan = the latest plan that
  // reached execution for this project (simplest correct read — the failed
  // plan itself is the most recent locked/running one).
  const previousPlan = await loadLatestPreviousPlan(parentRow.projectId);
  const repoSections = buildPlannerRepoSections({ repoPath: projectRow.repoPath, previousPlan });
  const sections = [...briefSections, ...repoSections];
  const additionalContext = sections.length > 0 ? sections.join('\n\n') : undefined;

  const runner = args.runner ?? defaultRunner();
  const outcome = await generatePlan(
    runner,
    team,
    extendedGoal,
    parentRow.projectId,
    additionalContext,
  );

  if (isRateLimitOutcome(outcome)) return null;
  // Planner kept inventing roles even after the corrective retry — fall
  // through to the walker's terminal-fail contract (null = task.failed).
  if (isPlannerRoleError(outcome)) return null;
  if (!isPlannerSuccess(outcome)) return null;

  // Re-stamp the goal to the project's authoritative goal verbatim. plan.goal is
  // the planner LLM's paraphrase of the extended (QA-context-laden) goal; the
  // walker feeds plan.goal to every executing agent, so the crew must build
  // against what the user wrote — not a drifted replan paraphrase. Mirrors the
  // same re-stamp in the POST plan route.
  // Re-stamp the team too via normalizePlanIdentity: stored specs win over any
  // planner paraphrase of model / prompt / allowedTools, and planner-set node
  // origins are stripped. A re-stamp miss is NOT unreachable — the user can
  // edit the team between run start and QA failure — so on a miss we log and
  // fall through to the walker's terminal-fail contract (null = task.failed)
  // instead of throwing out of the walker callback.
  const normalized = normalizePlanIdentity({ ...outcome.plan, goal: projectRow.goal }, team);
  if (!normalized.ok) {
    console.warn(
      JSON.stringify({
        event: 'replan-restamp-role-missing',
        projectId: parentRow.projectId,
        parentPlanId: args.parentPlanId,
        invalidRoles: normalized.invalidRoles,
      }),
    );
    return null;
  }
  const plan = normalized.plan;

  // Persist with parent_plan_id linkage.
  const newPlanId = randomUUID();
  await db
    .insert(plansTable)
    .values({
      id: newPlanId,
      projectId: parentRow.projectId,
      dagJson: plan as unknown,
      status: 'locked', // child plans go straight to locked since the run is already underway
      parentPlanId: args.parentPlanId,
    })
    .run();

  return { newPlanId, newPlan: plan };
}
