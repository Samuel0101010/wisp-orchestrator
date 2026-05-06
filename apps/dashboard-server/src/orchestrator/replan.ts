import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  plans as plansTable,
  projects,
  teams,
  type Plan as PlanShape,
  type Team,
} from '@agent-harness/schemas';
import { db } from '../db/index.js';
import {
  defaultRunner,
  generatePlan,
  isPlannerSuccess,
  isRateLimitOutcome,
  type Runner,
} from './planner-runner.js';

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
  const team = teamRow.rolesJson as unknown as Team;

  // Compose the extended goal — preserve the original at the top, append QA's context.
  const originalGoal = projectRow.goal;
  const extendedGoal =
    `${originalGoal}\n\n` +
    `## QA-Replan Context\n` +
    `The previous plan's QA task '${args.failedTaskId}' verified-failed terminally. ` +
    `Please regenerate a corrected plan addressing this QA failure:\n\n` +
    truncateError(args.qaError);

  const runner = args.runner ?? defaultRunner();
  const outcome = await generatePlan(runner, team, extendedGoal, parentRow.projectId);

  if (isRateLimitOutcome(outcome)) return null;
  if (!isPlannerSuccess(outcome)) return null;

  // Persist with parent_plan_id linkage.
  const newPlanId = randomUUID();
  await db
    .insert(plansTable)
    .values({
      id: newPlanId,
      projectId: parentRow.projectId,
      dagJson: outcome.plan as unknown,
      status: 'locked', // child plans go straight to locked since the run is already underway
      parentPlanId: args.parentPlanId,
    })
    .run();

  return { newPlanId, newPlan: outcome.plan };
}
