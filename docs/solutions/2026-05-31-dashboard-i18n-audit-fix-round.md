---
date: 2026-05-31
tags: [i18n, react-i18next, error-handling, e2e-playwright, audit]
files:
  - apps/dashboard-web/src/i18n/locales/de/common.json
  - apps/dashboard-web/src/i18n/index.ts
  - apps/dashboard-web/src/routes/Home.tsx
  - apps/dashboard-web/src/components/ErrorBoundary.tsx
  - apps/dashboard-server/src/routes/runs.ts
  - tests/e2e/smoke.spec.ts
related:
  - 2026-05-31-wisp-live-ui-testing-gotchas.md
  - 2026-05-31-tauri-packager-bundle-identifier.md
---

# Dashboard audit → fix round: i18n the dominant defect class (PR #80)

## Problem

A full live UI audit (every route + shell) plus three adversarial agent-review
workflows surfaced ~30 confirmed defects. The dominant class by far was **i18n**:
strings rendering in the wrong language for the active locale. Plus a cluster of
error-swallowing queries and a few real functional/data bugs.

## Root cause

- **`fallbackLng: 'en'` (i18n/index.ts).** A key missing from `de/common.json`
  falls back to the EN value (or the inline `t(key, 'default')`), so it renders
  **English inside the German UI**. Many `t()` call sites existed with English
  defaults but no DE key — they looked wired but showed English. NotFound +
  ErrorBoundary were the reverse: hardcoded German, so English users saw German.
- **Data bug disguised as i18n.** Home's "Today" KPI/greeting read
  `summary.totalRuns` (the 7-day window total) and labelled it "today" — wrong
  number *and* wrong word. It needed `dailyCounts.totalLast24h`, with a separate
  `totalRuns` kept for the run-outcomes card.
- **Error swallowing.** `useAgents`/`useAgentUsage` did `catch { return [] }`, so
  backend failures rendered as empty states with no error UI (the Agents
  ErrorBanner was dead code; AgentChat/Chat showed "no agents"/"not seeded").

## Solution

- Added ~110 DE/EN keys + wired hardcoded sites; localized NotFound and (as a
  class component) ErrorBoundary via `import i18n from '@/i18n'; i18n.t(...)`
  (hooks can't run in a class). Reused the existing `statusLabel(status, t)`
  helper for run-outcome columns instead of rendering the raw enum.
- Fixed the functional bugs (quick-run navigates, Today=24h count, PlanEditor
  repo-init no longer re-locks a locked plan → 409, etc.) and un-swallowed the
  error queries + added error states to their consumers.
- Server: `GET /api/runs?status=` now filters (validated against
  `runStatusValues`); `/api/insights/trajectories` `.limit(50)` removed so the
  Settings count + "clear all" cover >50 records.

## Key snippets

```js
// .tmp/audit/check-i18n-keys.mjs — scan every static t()/i18n.t() key vs locale
const re = /(?:\bi18n\.t|\bt)\(\s*(['"])([A-Za-z0-9_.]+)\1/g;
// ...report keys whose dotted path does NOT resolve in de/common.json
```

```ts
// Home: split the conflated value
const totalToday = dailyCounts.data?.totalLast24h ?? 0; // KPI "Today" + greeting
const totalRuns = summary.data?.totalRuns ?? 0;         // 7-day window (outcomes card)
```

## Verification

~878 unit/component tests + full Playwright e2e (54 passed, 2 skipped) green;
all 8 local gates per phase; adversarial fix-review workflow (server clean,
others "concerns" → MEDIUMs folded in); live-verified in Chrome. Shipped as
7 CI-green commits, squash-merged via PR #80.

## Lessons

- **A built i18n-key scanner beats eyeballing.** Scanning all 816 static `t()`
  keys against the DE locale found 26 gaps the agent audits missed. Caveat: it
  reports plural keys (`x_one`/`x_other`) as "missing" because it checks the base
  path — those resolve at runtime; verify live before treating one as a real gap.
- **Run e2e locally before pushing when you change user-facing text.** I skipped
  it (relied on Chrome-MCP live checks) and CI went red: localizing the Home hero
  button to "Neues Projekt" made it exactly equal the new-project dialog title, so
  a Playwright `getByText('Neues Projekt', { exact: true })` hit a strict-mode
  violation (button + heading both matched). Fix was to target the dialog heading
  (`getByRole('heading', { name })`) — but the lesson is to run the suite first.
- **`fallbackLng` hides i18n gaps in dev** if your dev locale happens to match the
  fallback; they only show in the *other* locale. Audit in the non-fallback
  language (here: German) to surface them.
- **Error-swallowing `catch { return [] }` is invisible until the backend fails.**
  Let queries reject (or expose `.error`) and make every consumer render an error
  state — not just the one route that has an ErrorBanner.
