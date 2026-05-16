# QA-driven replan (M5)

When a QA-role task fails terminally, the walker can swap in a freshly
generated plan that incorporates the QA error context — the run continues
under the same `runId` instead of going to terminal failure.

## When does it fire?

- The failed task's role is literally `qa` — the walker matches
  `node.role === 'qa'` in
  [`packages/orchestrator/src/walker.ts`](../packages/orchestrator/src/walker.ts).
  Renaming the role (e.g. to `quality`) disables the replan branch.
- The run hasn't already used its replan budget (capped at **1** per run).

If the QA fail comes after a previous replan, the walker emits
`qa.replan-exhausted` and lets the run terminate — no infinite loops.

## Branch namespacing

Replanning rewrites task ids and branch prefixes so the v1 attempt's branches
are preserved:

| Plan version | Branch prefix                       |
| ------------ | ----------------------------------- |
| Original     | `harness/<runId>/<taskId>`          |
| 1st replan   | `harness/<runId>/v2/<taskId>`       |
| Nth replan   | `harness/<runId>/vN/<taskId>`       |

`done` tasks carried over from the previous version keep their **original**
branch — the walker resolves them via `task.branchName` rather than the
current prefix. The
[`docs/solutions/2026-05-07-replan-branch-prefix-carried-over-deps.md`](solutions/2026-05-07-replan-branch-prefix-carried-over-deps.md)
entry describes the bug class and the `branchForDep` helper that fixes it.

## Audit trail

Every plan row carries `parent_plan_id`. The chain is queryable via:

```
GET /api/plans/:planId/chain
→ [{ id, parentPlanId, status, createdAt }, …]   // newest → oldest
```

Migration `0003_plan_versions.sql`
([`apps/dashboard-server/drizzle/`](../apps/dashboard-server/drizzle/))
adds the column; backfill is unnecessary because pre-M5 plans simply have
`parent_plan_id = NULL`.

## Walker callback

The walker dispatches replan via a deps callback so it stays HTTP-free:

```ts
WalkerDeps.replanOnQAFailure?: (args: {
  failedPlan: Plan;
  failedTaskId: string;
  qaError: string;
}) => Promise<{ newPlan: Plan; newPlanId: string } | null>;
```

The server wires this to a refactored `generatePlan` helper in
[`apps/dashboard-server/src/orchestrator/replan.ts`](../apps/dashboard-server/src/orchestrator/replan.ts).
The helper composes an extended goal that includes the QA error tail, then
runs the planner subprocess again with the project's existing team. On
success it inserts a new `plans` row with `status='locked'` and
`parent_plan_id` pointing at the failed plan.

A returned `null` (e.g. planner failure, malformed DAG) is treated like
`replan-exhausted` — the walker stops dispatching and the run terminates.

## Events

- `qa.replan-triggered` — emitted before the walker swaps plans. Payload:
  `{ runId, failedTaskId, reason }`.
- `qa.replan-exhausted` — emitted when the cap was already reached or the
  callback returned `null`. Payload: same shape.

The `/wisp-diagnose` skill highlights both event types in its timeline
output.

## UI

The PlanEditor and RunView both render a `PlanVersionBadge` showing
"v2 (replanned from v1: <reason>)" when `parent_plan_id` is set. Clicking
the badge opens the chain query result so the user can pivot between
versions.

## Validation

Real-Claude validation run for M5 is documented in
[`docs/real-run-notes.md`](real-run-notes.md) under the
"v1.0 QA-replan real-Claude run (M5 acceptance)" section: a deliberately
strict QA prompt forced a pi-precision failure, the walker triggered one
replan, and the second attempt completed successfully with `Math.PI`.
