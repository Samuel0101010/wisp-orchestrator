---
date: 2026-05-11
tags: [pnpm, drizzle-orm, better-sqlite3, peer-dependencies, monorepo-tooling]
files:
  - package.json
  - pnpm-lock.yaml
related:
  - 2026-05-10-thompson-sampling-model-router.md
  - 2026-05-07-better-sqlite3-concurrent-writers-busy-timeout.md
---

# pnpm specialised drizzle-orm into two paths; TS exploded with 738 errors in CI only

## Problem

After adding `promptfoo` as a root devDependency, CI typecheck failed with 738 cascading errors of the shape:

```
Property 'config' is protected but type 'Column<...>' is not a class derived from 'Column<...>'.
Types have separate declarations of a private property 'shouldInlineParams'.
```

Errors centered on `db.select().from(plansTable).where(eq(plansTable.id, ...))` in `apps/dashboard-server/src/workers/handlers/run-summary-fallback.ts`. Local `pnpm typecheck` was clean — only CI's `--frozen-lockfile` clean install reproduced it.

## Root cause

`promptfoo`'s transitive `drizzle-orm@0.45.2` pulls `better-sqlite3@12.9.0` as a peer. Our app already had `better-sqlite3@^11.0.0` (resolved to `11.10.0`). With two `better-sqlite3` versions in the workspace, pnpm specialised our `drizzle-orm@0.36.4` against both peer contexts, producing two physical paths under `node_modules/.pnpm`:

```
drizzle-orm@0.36.4(@types/better-sqlite3@7.6.13)(better-sqlite3@11.10.0)(...)
drizzle-orm@0.36.4(@types/better-sqlite3@7.6.13)(better-sqlite3@12.9.0)(...)
```

`packages/schemas` and `apps/dashboard-server` ended up importing `drizzle-orm` from different specialisations. TypeScript treats their exported `SQLiteColumn` / `SQLWrapper` types as distinct (private property identity), so every `eq(table.col, ...)` call across the package boundary failed type-checking.

Locally, the long-lived `node_modules` had naturally deduped — making the bug invisible until CI's clean install exposed it.

## Solution

Pin `better-sqlite3` to a single version via `pnpm.overrides` in the root `package.json`. This collapses the peer specialisation back to one `drizzle-orm@0.36.4` path.

## Key snippets

```json
// package.json
"pnpm": {
  "onlyBuiltDependencies": ["better-sqlite3", "esbuild"],
  "overrides": {
    "better-sqlite3": "^11.10.0"
  }
}
```

Verify the lockfile collapsed to one specialisation:

```bash
grep -E "^\s+drizzle-orm@0.36" pnpm-lock.yaml | sort -u
# expect a single line ending in (better-sqlite3@11.10.0)
```

## Verification

- `pnpm install` re-resolved with the override.
- `grep "^\s+better-sqlite3@" pnpm-lock.yaml` now shows only `11.10.0`.
- `grep "^\s+drizzle-orm@0.36" pnpm-lock.yaml` collapsed from two entries to one.
- CI `verify` job went from 738 errors to ✓ pass (2m17s on main).

## Lessons

- `pnpm typecheck` passing locally is no guarantee the lockfile is consistent. Long-lived `node_modules` can dedupe naturally where a clean `--frozen-lockfile` install will specialise on peer contexts.
- The error message ("`Property 'config' is protected but type X is not a class derived from X`") looks nonsensical at first read. Whenever the SAME type name appears on both sides of an incompatibility error, suspect package duplication — grep the lockfile for two entries of the offending package.
- `pnpm.overrides` is the blunt-but-correct fix when a transitive dep forces an incompatible peer. The cost is forcing the transitive dep to use an older version (here promptfoo's drizzle-orm@0.45.2 ends up on better-sqlite3@11.10.0 instead of 12.9.0) — acceptable when the transitive dep is dev-only.
- The blast radius of this kind of break is enormous (738 errors here) but the actual code change to fix is tiny (3 lines of JSON). Time wasted on chasing symptom-level edits dwarfs the time to look at the lockfile.
