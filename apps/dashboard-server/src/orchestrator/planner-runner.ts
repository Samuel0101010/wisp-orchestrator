import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { safeParsePlan, validateDag, validatePlanRoles, type Plan, type Team } from '@wisp/schemas';
import { runClaude } from '@wisp/orchestrator';
import type { RunClaudeOpts } from '@wisp/orchestrator';
import type { HarnessEvent } from '@wisp/schemas';
import { env } from '../env.js';
import { publishToRun } from '../ws.js';
import { buildPlannerPrompt, plannerSpecFor } from './planner.js';
import { makeMockRunner } from './mock-runner.js';

export type Runner = (opts: RunClaudeOpts) => AsyncIterable<HarnessEvent>;

const MAX_ATTEMPTS = 3;
const PLANNER_MAX_TURNS = 20;

export interface PlannerError {
  attempts: number;
  error: string;
}

/**
 * Terminal outcome when the planner kept emitting roles that don't exist in
 * the stored team even after one corrective retry. Distinct from PlannerError
 * so the route can surface the invalid/allowed role lists to the client.
 */
export interface PlannerRoleError {
  attempts: number;
  code: 'invalid_roles';
  /** Union of invalid team + node roles, deduped. */
  invalidRoles: string[];
  /** Stored team role strings. */
  allowedRoles: string[];
  error: string;
}

export interface PlannerSuccess {
  attempts: number;
  plan: Plan;
}

export interface RateLimitOutcome {
  rateLimit: { resetAt: number | null };
}

export type PlannerOutcome = PlannerSuccess | PlannerError | PlannerRoleError | RateLimitOutcome;

export function isRateLimitOutcome(o: PlannerOutcome): o is RateLimitOutcome {
  return (o as RateLimitOutcome).rateLimit !== undefined;
}

export function isPlannerSuccess(o: PlannerOutcome): o is PlannerSuccess {
  return (o as PlannerSuccess).plan !== undefined;
}

export function isPlannerRoleError(o: PlannerOutcome): o is PlannerRoleError {
  return (o as PlannerRoleError).code === 'invalid_roles';
}

async function runPlannerOnce(
  runner: Runner,
  cwd: string,
  prompt: string,
  team: Team,
  projectId: string,
): Promise<{ rateLimit: { resetAt: number | null } | null; failed: string | null }> {
  const spec = plannerSpecFor(team);
  // `planner-` prefix lets WISP_MOCK_CLI mode distinguish planner calls
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

export async function generatePlan(
  runner: Runner,
  team: Team,
  goal: string,
  projectId: string,
  additionalContext?: string,
): Promise<PlannerOutcome> {
  const cwd = mkdtempSync(path.join(env.WISP_DATA_DIR, 'planner-'));
  const planJsonPath = path.join(cwd, 'plan.json');
  const basePrompt = additionalContext
    ? `${buildPlannerPrompt(goal, team)}\n\n${additionalContext}`
    : buildPlannerPrompt(goal, team);

  let lastError = '';
  let attempts = 0;
  let roleRetryUsed = false;
  // Tracks whether the MOST RECENT failure was a role failure, so exhausting
  // the attempt budget on a role failure still surfaces PlannerRoleError (with
  // its invalidRoles/allowedRoles diagnostic) instead of the generic error.
  let lastRoleFailure: { invalidRoles: string[]; allowedRoles: string[] } | null = null;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      lastRoleFailure = null;
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

      // Role chokepoint: every role in the plan must exist in the stored team.
      // Runs BEFORE any server-side injection (wire-up / runtime-verifier /
      // lead happen later in plans.ts), so system roles are never flagged.
      // One corrective retry with the exact allowed list; persistent failure
      // is a distinct terminal outcome so the route can surface the lists.
      const roleCheck = validatePlanRoles(safe.data, team);
      if (!roleCheck.ok) {
        const invalidRoles = [
          ...new Set([...roleCheck.invalidTeamRoles, ...roleCheck.invalidNodeRoles]),
        ];
        const allowedRoles = team.roles.map((r) => r.role);
        lastError = `plan uses roles not in the team: ${invalidRoles.join(', ')}. Allowed roles are EXACTLY: ${allowedRoles.join(', ')}. Use only these literal strings.`;
        lastRoleFailure = { invalidRoles, allowedRoles };
        if (!roleRetryUsed) {
          roleRetryUsed = true;
          continue;
        }
        return { attempts, code: 'invalid_roles', invalidRoles, allowedRoles, error: lastError };
      }

      return { plan: safe.data, attempts };
    }

    // Budget exhausted. If the final attempt failed on roles (e.g. the FIRST
    // role failure landed on the last attempt, so the corrective retry never
    // ran), surface the structured role outcome — not the generic error.
    if (lastRoleFailure) {
      return {
        attempts,
        code: 'invalid_roles',
        invalidRoles: lastRoleFailure.invalidRoles,
        allowedRoles: lastRoleFailure.allowedRoles,
        error: lastError || 'planner failed',
      };
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

export function defaultRunner(): Runner {
  if (env.WISP_MOCK_CLI) {
    return makeMockRunner();
  }
  return (opts: RunClaudeOpts) => runClaude(opts);
}
