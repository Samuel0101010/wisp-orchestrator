/**
 * Self-healing chain — hardening plan builder.
 *
 * After a successful run we (optionally, per project flag) scan its result
 * branch for HIGH/CRITICAL findings (see findings.ts). If any remain, we
 * build a small hand-crafted "hardening plan" containing two tasks:
 *
 *   1. security  → fix all CRITICAL+HIGH+MEDIUM findings listed in the
 *      prompt. Touches docs/security-review.md so the next iteration's
 *      scan sees the new state.
 *   2. qa-engineer → run lint + tests, refresh docs/qa-report.md.
 *
 * The plan is intentionally tiny: complex multi-role replans are what the
 * normal planner is for. The self-healing loop's job is narrow — close
 * known findings against a finished codebase — and the simpler the plan,
 * the more predictable the iteration.
 *
 * The chain is bounded by `projects.maxChainIterations`. Iteration 0 is
 * the user-launched run; iterations 1..N are self-healing follow-ups.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  plans as plansTable,
  projects as projectsTable,
  tasks as tasksTable,
  BUILDER_DISCIPLINE_SKILL,
  QA_VERIFICATION_SKILL,
  type Plan,
  type TaskRole,
} from '@wisp/schemas';
import type { Finding } from './findings.js';
import { formatFindingsForGoal } from './findings.js';

const HARDEN_TEAM = {
  roles: [
    {
      role: 'security',
      model: 'sonnet' as const,
      allowedTools: [
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'Bash(npm:*, pnpm:*, npx:*, git:*, node:*)',
      ],
      systemPrompt:
        'You are the security engineer on a self-healing harness pass. The prior run produced a working codebase, but the security review listed remaining HIGH/CRITICAL/MEDIUM findings. Your job: fix EVERY finding listed in the task prompt, in-place, in the working tree. Edit source files surgically — do not rewrite the architecture. Re-run `npm run lint` and `npm test` after every batch of changes; both must stay green. When all listed findings are addressed, update `docs/security-review.md` so the corresponding rows are marked **RESOLVED** (severity column → INFO, recommendation column → short note pointing at the commit). Commit nothing yourself; the harness handles git.',
      skills: [BUILDER_DISCIPLINE_SKILL],
    },
    {
      role: 'qa-engineer',
      model: 'haiku' as const,
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'Bash(npm:*, pnpm:*, npx:*, git:*, node:*)',
        'Edit',
        'Write',
      ],
      systemPrompt:
        'You are the QA engineer for a self-healing harness pass. After the security engineer claims all findings resolved, you verify: (1) `npm run lint` exits 0, (2) `npm test` exits 0 with no new failures vs. the prior run, (3) `docs/security-review.md` no longer contains any HIGH or CRITICAL severity rows. Refresh `docs/qa-report.md` with the iteration date, the test count, and an explicit list of which prior findings have been closed. Report PASS only if all three gates hold; FAIL with concrete evidence (command output, file paths, line numbers) otherwise. Do not modify source code.',
      skills: [QA_VERIFICATION_SKILL],
    },
  ],
};

const DEFAULT_HARDEN_MAX_TURNS_SECURITY = 80;
const DEFAULT_HARDEN_MAX_TURNS_QA = 40;

export interface BuildHardeningPlanArgs {
  /** Goal text from the original project (so context isn't lost). */
  parentGoal: string;
  iteration: number;
  findings: Finding[];
}

export function buildHardeningPlan(args: BuildHardeningPlanArgs): Plan {
  const findingsBlock = formatFindingsForGoal(args.findings);
  const goal = `Self-healing pass #${args.iteration} for the prior run.

## Parent goal context

${args.parentGoal}

## Remaining findings to resolve

${findingsBlock || '(no findings listed — this run should be a no-op)'}`;

  const securityPrompt = `Fix every finding listed below. For each finding, locate the named file/line, apply the smallest correct edit, then re-run \`npm run lint\` and \`npm test\` to confirm nothing regressed.

After all findings are resolved, edit \`docs/security-review.md\` so each addressed row's severity becomes **INFO** and its recommendation becomes a short \`RESOLVED — <one-line summary>\` note. Do not delete the rows — the audit history is part of the report.

### Findings

${findingsBlock}

### Gates to keep green
- \`npm ci\` (already done by the harness checkout)
- \`npm run lint\` — 0 warnings
- \`npm test\` — all existing tests still pass

If a finding is genuinely unfixable (e.g. requires a domain placeholder you don't have), leave the row at its current severity and add a \`BLOCKED — <reason>\` note in the recommendation column. Don't fake it.`;

  const qaPrompt = `Verify the security engineer's pass:

1. \`npm run lint\` exits 0, no warnings.
2. \`npm test\` exits 0, test count is equal to or greater than the prior iteration.
3. \`docs/security-review.md\` contains no rows with severity **HIGH** or **CRITICAL**. Rows marked **BLOCKED** count as not-yet-fixed but acceptable for this gate.

Update \`docs/qa-report.md\` with a new section titled "## Hardening iteration ${args.iteration}". List each closed finding with a one-line summary. End with **PASS** if all three gates hold; **FAIL** otherwise.`;

  const plan: Plan = {
    goal,
    team: HARDEN_TEAM,
    nodes: [
      {
        id: 'n1-harden',
        role: 'security',
        prompt: securityPrompt,
        deps: [],
        successCriteria: {
          build: 'npm ci',
          lint: 'npm run lint',
          test: 'npm test',
        },
        maxTurns: DEFAULT_HARDEN_MAX_TURNS_SECURITY,
      },
      {
        id: 'n2-qa-verify',
        role: 'qa-engineer',
        prompt: qaPrompt,
        deps: ['n1-harden'],
        successCriteria: {
          lint: 'npm run lint',
          test: 'npm test',
        },
        maxTurns: DEFAULT_HARDEN_MAX_TURNS_QA,
      },
    ],
    edges: [{ from: 'n1-harden', to: 'n2-qa-verify' }],
  };

  return plan;
}

export interface InsertHardeningPlanArgs {
  db: BetterSQLite3Database;
  projectId: string;
  parentPlanId: string;
  plan: Plan;
}

/**
 * Persist the hardening plan + its seed task rows. Returns the new plan's id.
 */
export async function insertHardeningPlan(args: InsertHardeningPlanArgs): Promise<string> {
  const planId = randomUUID();
  await args.db
    .insert(plansTable)
    .values({
      id: planId,
      projectId: args.projectId,
      dagJson: args.plan as unknown,
      status: 'locked', // skip the draft → locked dance — this plan is system-built
      parentPlanId: args.parentPlanId,
    })
    .run();
  for (const node of args.plan.nodes) {
    await args.db
      .insert(tasksTable)
      .values({
        id: node.id,
        planId,
        role: node.role as TaskRole,
        title: node.id,
        deps: node.deps,
        status: 'pending',
      })
      .run();
  }
  return planId;
}

export interface ShouldChainArgs {
  selfHealingEnabled: boolean;
  chainIteration: number;
  maxChainIterations: number;
  actionableFindingsCount: number;
}

/**
 * Plateau detection for the self-healing chain: true when the just-finished
 * iteration closed zero findings (the actionable count did not decrease vs.
 * the parent run). `previousCount === null` means the parent run could not
 * be scanned — never report a plateau in that case (an unscannable parent
 * must not stop the chain).
 */
export function isPlateau(previousCount: number | null, currentCount: number): boolean {
  return previousCount !== null && currentCount >= previousCount;
}

/** Pure-logic gate for whether the post-success hook should spawn another iteration. */
export function shouldChainHardeningRun(args: ShouldChainArgs): boolean {
  if (!args.selfHealingEnabled) return false;
  if (args.chainIteration >= args.maxChainIterations) return false;
  if (args.actionableFindingsCount === 0) return false;
  return true;
}

/**
 * Read repoPath + parent goal + project flags for a finished run. Used by
 * the runtime's post-success hook. Centralised here so the hook in
 * runtime.ts stays compact.
 */
export interface ProjectChainContext {
  projectId: string;
  repoPath: string;
  goal: string;
  selfHealingEnabled: boolean;
  autoMergeOnSuccess: boolean;
  maxChainIterations: number;
  /** v1.8: when true, the post-success hook reads docs/runtime-report.json
   *  + evaluates the release-gate before auto-merge. When false the gate is
   *  skipped and behavior matches v1.7 (auto-merge on any successful run). */
  runtimeVerifyEnabled: boolean;
}

export function loadProjectChainContext(
  db: BetterSQLite3Database,
  projectId: string,
): ProjectChainContext | null {
  const p = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
  if (!p) return null;
  return {
    projectId: p.id,
    repoPath: p.repoPath,
    goal: p.goal,
    selfHealingEnabled: Boolean(p.selfHealingEnabled),
    autoMergeOnSuccess: Boolean(p.autoMergeOnSuccess),
    maxChainIterations: p.maxChainIterations,
    runtimeVerifyEnabled: Boolean(p.runtimeVerifyEnabled),
  };
}
