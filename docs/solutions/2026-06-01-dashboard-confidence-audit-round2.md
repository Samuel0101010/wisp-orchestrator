---
date: 2026-06-01
tags: [i18n, react-i18next, audit, agent-workflows, data-loss]
files:
  - apps/dashboard-web/src/lib/status-labels.ts
  - apps/dashboard-web/src/components/home/OutcomeDonut.tsx
  - apps/dashboard-web/src/routes/TeamBuilder.tsx
  - apps/dashboard-web/src/components/BuildAppCard.tsx
  - apps/dashboard-web/src/api/queries.ts
related:
  - 2026-05-31-dashboard-i18n-audit-fix-round.md
  - 2026-05-31-wisp-live-ui-testing-gotchas.md
---

# Second confidence-audit pass: the bug classes a first "all fixed" sweep misses (PR #81)

## Problem

After the round-1 audit declared the dashboard "done", a re-verify request ("re-check
everything you're not 100% sure about") ran two adversarial agent workflows over every
tab. They surfaced 15 real defects the first sweep missed — including a HIGH-severity
silent data-loss bug and a data bug whose root cause the round-1 audit had asserted
*incorrectly*.

## Root cause — the recurring classes

- **Raw-enum token leak via `statusLabel`.** `statusLabel(x,t)` does
  `t(`status.${x}`, { defaultValue: x })`, so a missing key renders the raw snake_case
  token in BOTH locales. The `status.*` namespace covered the *status* enums but not
  every value that actually reaches the helper: `run.outcome` values flow in too, and
  `budget_exceeded` (a real terminal outcome from the cost-kill / autopilot paths) had no
  key → "Failed (budget_exceeded)" leaked in RunView/ProjectDetail/Insights. The fix is a
  key; the lesson is to trace call-sites against the **full reachable enum set**, not the
  one enum the namespace was named after.
- **Server-keyed-by-enum vs client-known-keys.** `/api/runs/summary` builds
  `outcomeCounts[r.outcome]` keyed by the raw enum, but `OutcomeDonut` only knows 4 keys
  (success/failure/cancelled/unknown). A `budget_exceeded` run was therefore neither shown
  nor folded into `unknown` — it **vanished**, and the donut total silently undercounted
  vs. the card's run count. (Round 1 had *asserted* it bucketed as unknown→Pending, never
  verified — the completeness critic flagged exactly this unverified claim.)
- **Silent data-loss through a draft round-trip.** `AgentSpec.agentId` is an optional
  soft-link to a persistent agent (set when a team is created from chat). TeamBuilder's
  `specToDraft`/`draftToSpec` copied every field *except* `agentId`, so opening + re-saving
  such a team stripped the link — and `teamsEqual` didn't compare `agentId`, so the
  dirty-check never warned. Adding an optional field to a shared schema requires auditing
  **every** spec↔draft mapper and equality function, not just the editing UI.

## Solution

- Add `status.budget_exceeded` to both locales (+ the round's other i18n leaks:
  AgentChat, Focusboard KPIs, Chat invoke_skill card, TestPromptDialog wired to its
  already-existing-but-unused `testPrompt` namespace, ToolMultiSelect, PromptBundles,
  RunView's raw `idle` ws-pill).
- `OutcomeDonut`: fold `budget_exceeded` into the `failure` bucket (matches Home's own
  `classify()`), client-side — no API change, total now matches.
- TeamBuilder: round-trip `agentId` through `specToDraft`/`draftToSpec` and add it to
  `teamsEqual`. Export the two pure mappers and unit-test the round-trip directly.
- BuildAppCard: read the typed code from `ApiError.body.error` (was regex-matching the
  always-generic `.message`, so every failure showed "Tauri build failed").
- Chat: narrow the 4 thread-query catches to 404-only (were swallowing 500s as empty).
- Home: interpolate the period into KPI/chart captions; pluralize greeting + chips.
- Goap: fix the dead-branch `setEnabled` (both branches were `out.add(n)`); track prev
  names in a ref so a toggled-off action stays off across a JSON edit.

## Key snippets

```ts
// OutcomeDonut — a budget_exceeded run is a failure outcome; fold it so the
// donut total matches the run count instead of dropping the run.
const merged = { ...counts, failure: (counts.failure ?? 0) + (counts.budget_exceeded ?? 0) };
```

```ts
// BuildAppCard — typed code lives in the BODY, not the message.
const body = err instanceof ApiError && err.body && typeof err.body === 'object'
  ? (err.body as { error?: string; message?: string }) : null;
const code = body?.error; // not err.message (always "Request failed: <status> …")
```

## Verification

8 gates green (662 unit/component tests), Playwright e2e 54 passed / 2 skipped (incl. the
per-locale `visible strings match the active locale` spec), DE/EN parity 1088 leaves each,
live-verified in Chrome (period captions track the 24h/7d/30d toggle; `1 Run heute.` /
`0 laufen` plurals). Shipped as PR #81 (commit 6135c99), CI verify+e2e green.

## Lessons

- **A first "all fixed" sweep has blind spots a second adversarial pass finds.** Structure:
  map (per-area) → skeptic-refute each claim → **completeness critic** → feed the critic's
  "never examined" list into a SECOND focused workflow. The agentId data-loss bug lived in
  TeamBuilder, which the first sweep's 7 areas never touched; the critic named it, round 2
  confirmed it.
- **Distrust your own prior audit's unverified claims.** Round 1 wrote "the donut buckets
  budget_exceeded as unknown" — false. A refute-by-default verifier that re-reads the data
  path catches assertions that were plausible but never traced.
- **jsdom UI-interaction tests are fragile for non-default state.** Driving a *loaded* (vs
  the 404-default) TeamBuilder team to dirty-then-save via prompt-edit/add-role didn't
  reproduce reliably. Exporting the pure mapper functions and unit-testing the round-trip
  is deterministic and tests the exact fix.
- **Watch for `t` shadowing.** `value.map((t) => …)` shadows the i18n `t`; precompute the
  translated strings above the map.
- **Run e2e locally before pushing when user-facing text changes** (again) — it stayed
  green this time precisely because round 1's strict-mode-collision lesson was applied up
  front.
