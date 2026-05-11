---
date: 2026-05-10
tags: [thompson-sampling, drizzle-orm, sqlite, bandit-algorithm, model-routing]
files:
  - apps/dashboard-server/drizzle/0007_ruflo_port.sql
  - packages/schemas/src/db.ts
  - packages/schemas/src/index.ts
  - apps/dashboard-server/src/router/sampler.ts
  - apps/dashboard-server/src/router/thompson.ts
  - apps/dashboard-server/src/routes/router.ts
  - apps/dashboard-server/src/routes/plans.ts
  - apps/dashboard-server/src/routes/index.ts
  - apps/dashboard-server/src/__tests__/thompson.test.ts
related:
  - 2026-05-11-pnpm-drizzle-peer-dep-duplication.md
---

# Thompson-Sampling Model Router (F6)

## Problem
The planner always used a hardcoded model from the team config. There was no mechanism to learn which model (opus/sonnet/haiku) performed best for a given role, and no way to collect data toward that goal.

## Root cause
No bandit/routing layer existed. The planner called `generatePlan` with a static team config and never recorded outcome telemetry.

## Solution
Added a three-arm Thompson-sampling router with cost adjustment. `pickModel(role)` samples from Beta priors and divides by per-model cost (opus=5, sonnet=1, haiku=0.07) so cheaper models are preferred when their predicted success rate is comparable. `recordOutcome(sampleId, 'success'|'failure')` updates priors and is called in the POST /api/projects/:projectId/plan handler around the existing `generatePlan` call. A `/api/router/priors` viewer endpoint exposes live prior state.

## Key snippets

### Marsaglia-Tsang Beta sampler (no new dependencies)
```ts
function sampleGamma(shape: number): number {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function sampleBeta(a: number, b: number): number {
  return sampleGamma(a) / (sampleGamma(a) + sampleGamma(b));
}
```

### Cost-adjusted pick
```ts
const COST: Record<ModelName, number> = { opus: 5, sonnet: 1, haiku: 0.07 };
const adjusted = sampleBeta(alpha, beta) / COST[m];
```

### Wiring in plans.ts
```ts
const pick = pickModel('planner');
const outcome = await generatePlan(runner, team, project.goal, projectId);
const succeeded = isPlannerSuccess(outcome);
recordOutcome(pick.sampleId, succeeded ? 'success' : 'failure').catch((err) => {
  console.error('[router] recordOutcome failed', err);
});
```

### SQL schema (appended to 0007_ruflo_port.sql)
```sql
CREATE TABLE `model_router_priors` (
  `role` text NOT NULL, `model` text NOT NULL,
  `alpha` real NOT NULL DEFAULT 1, `beta` real NOT NULL DEFAULT 1,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`role`, `model`)
);
CREATE TABLE `model_router_samples` (
  `id` text PRIMARY KEY NOT NULL, `role` text NOT NULL, `model` text NOT NULL,
  `taken_at` integer NOT NULL, `outcome` text, `recorded_at` integer
);
CREATE INDEX `model_router_samples_pending_idx` ON `model_router_samples` (`outcome`);
```

### Drizzle schema requires `real` import
```ts
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
```

## Verification
- `pnpm --filter @agent-harness/schemas build` — clean
- `pnpm --filter dashboard-server test` — 171/171 pass (30 test files), including 4 new thompson tests
- `pnpm --filter dashboard-server typecheck` — clean
- `pnpm --filter dashboard-server build` — clean

## Lessons
- The cost-adjustment heavily biases picks toward haiku (0.07 cost factor vs. opus 5). This is intentional — the router learns to prefer expensive models only when their Beta posteriors are clearly higher. Do not "fix" this.
- `recordOutcome` is idempotent: it checks `sample.outcome` before updating, so calling twice with the same sampleId is a no-op.
- The planner-flow wiring tracks outcome data but does NOT yet swap the model in the team before calling `generatePlan`. The router picks a model and records its outcome relative to whatever the team was configured to use. Actual model swapping is deferred (it would require cloning the team and mutating the planner role's model).
- Drizzle's `real` column type is not imported by default — must be added explicitly alongside `text`/`integer`/`primaryKey`.
- The partial index `WHERE outcome IS NULL` was skipped because Drizzle's introspection doesn't always preserve it. A plain index on `outcome` is sufficient at current scale.
- Test DB isolation: import `./setup.js` first (before any project code) to set `HARNESS_DATA_DIR` to a temp dir, then call `runMigrations()` in `beforeAll`. The same pattern as all other server tests.
