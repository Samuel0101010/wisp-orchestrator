---
date: 2026-05-30
tags: [drizzle-migrations, sqlite, uuid-ordering, vite-build-staleness, wisp]
files:
  - apps/dashboard-server/drizzle/0019_plan_created_at.sql
  - apps/dashboard-server/drizzle/meta/_journal.json
  - packages/schemas/src/db.ts
  - apps/dashboard-server/src/routes/plans.ts
  - apps/dashboard-server/src/routes/chat-directives.ts
  - apps/dashboard-server/src/routes/org-chart.ts
related:
  - 2026-05-29-wisp-dogfood-preview-after-run-working-tree.md
  - 2026-05-31-wisp-live-ui-testing-gotchas.md
  - 2026-05-29-better-sqlite3-node24-prebuilt-gap.md
---

# Plan-recency bug (UUID ordering) + the hand-written-drizzle-migration trap (v2.0.27)

## Problem

The "latest plan" for a project was wrong ~50% of the time once a project had
2+ plans. Three sites selected it with `orderBy(desc(plans.id))`, but
`plans.id` is a random UUIDv4 — no time component — so `desc(id)` returns the
lexicographically-largest UUID, not the newest plan. Affected: `GET
/api/projects/:id/plan`, the chat `start_run` directive's plan lookup
(`chat-directives.ts`), and the org-chart. Iteration / replan / self-healing
all create follow-up plans, so it was reachable in normal use.

While fixing it, the bigger time-sink was the migration mechanism: running
`drizzle-kit generate` produced a catastrophic migration that tried to
re-`CREATE TABLE` every existing table and re-`ADD` every existing column.

## Root cause

- **Bug:** `plans` had no timestamp column and the PK is `randomUUID()`
  (UUIDv4, not time-sortable like ULID/UUIDv7). `desc(id)` ≠ recency.
- **Migration trap:** the `drizzle/meta/` snapshots were abandoned after
  `0003` — migrations 0004–0018 are hand-written `.sql` files with no matching
  snapshot. `drizzle-kit generate` diffs the live schema against the *stale*
  `0003` snapshot, so it "discovers" 15 migrations' worth of tables/columns as
  missing and emits them all into one file. Applying it would fail (duplicate
  table/column). The runtime migrator (`db/migrate.ts` → drizzle `migrate()`)
  only reads `meta/_journal.json` + the `.sql` files; the snapshots are unused
  at runtime, which is why nobody noticed they were dead.

## Solution

Hand-write the migration the way 0004–0018 were done, and add a SQL-level
`DEFAULT` (the schema `$defaultFn` is app-level only — it does NOT backfill
existing rows, so a bare `NOT NULL` add fails on a populated table):

1. Add the column to `packages/schemas/src/db.ts`:
   `createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date())`
2. Hand-write `drizzle/0019_plan_created_at.sql` (NOT via `generate`).
3. Hand-append the `meta/_journal.json` entry.
4. Switch all three read sites to `orderBy(desc(plans.createdAt), desc(plans.id))`
   (`id` is a deterministic tiebreaker for pre-migration rows backfilled to 0).

## Key snippets

```sql
-- drizzle/0019_plan_created_at.sql  (hand-written; backfill keeps NOT NULL valid)
ALTER TABLE `plans` ADD COLUMN `created_at` integer NOT NULL DEFAULT 0;
```

```jsonc
// drizzle/meta/_journal.json — append to entries[]
{ "idx": 19, "version": "6", "when": 1779500000007, "tag": "0019_plan_created_at", "breakpoints": true }
```

```ts
// the fix at each of the 3 sites
.orderBy(desc(plans.createdAt), desc(plans.id))
```

To undo a stray `drizzle-kit generate`:
```bash
git checkout apps/dashboard-server/drizzle/meta/_journal.json
rm apps/dashboard-server/drizzle/0019_special_*.sql apps/dashboard-server/drizzle/meta/0019_snapshot.json
```

## Verification

- `migrations.test.ts` (8) + `org-chart.test.ts` (6, rewritten so the OLDER
  plan has a lexicographically LARGER id but earlier `created_at` — a
  regression to `desc(id)` fails it) green.
- All 9 gates green; full suite 474 → 509 tests; CI 6m24s; v2.0.27 released.
- Live in the real prod DB after restart: the pre-existing pomodoro plan
  serializes `createdAt: 1970-01-01T00:00:00.000Z` (the epoch backfill),
  confirming migration 0019 applied on boot and any new plan (real ms
  timestamp) outranks it.

## Lessons

- **Never run `drizzle-kit generate` in this repo.** Snapshots are dead since
  `0003`; it emits garbage. Hand-write `drizzle/00NN_name.sql` + a
  `meta/_journal.json` entry. Runtime uses journal + sql only.
- **`$defaultFn` is app-level, not SQL.** A `NOT NULL` column add on a
  populated table needs a SQL `DEFAULT` in the migration or it fails.
- **The bundled web `dist/` is gitignored and silently goes stale.** The
  sidebar version chip = web `__APP_VERSION__` (baked at build time). After a
  version bump, `WISP_SERVE_WEB=1` keeps serving the OLD bundle until
  `pnpm --filter @wisp/dashboard-web build`. Rebuild before any bundled-mode
  "as-a-user" verification, or you test the old frontend (this round, the
  bundle was stuck at v2.0.23 and the v2.0.24 generate_plan UI had never
  actually been exercised in the bundle). Do NOT rebuild while the server
  serves from `dist/` — Vite rewrites the dir mid-flight → transient 404s.
- For multi-row recency on UUIDv4 PKs, prefer an explicit `created_at` (or
  migrate to ULID/UUIDv7) over PK ordering.
