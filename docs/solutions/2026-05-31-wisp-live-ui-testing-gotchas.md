---
date: 2026-05-31
tags: [testing, chrome-devtools-mcp, react, react-query, runtime-report]
files:
  - apps/dashboard-web/src/api/queries.ts
  - apps/dashboard-web/src/components/ReleaseGateCard.tsx
  - apps/dashboard-web/src/routes/RunView.tsx
related:
  - 2026-05-30-drizzle-hand-written-migrations-plan-recency.md
  - 2026-05-29-wisp-dogfood-preview-after-run-working-tree.md
  - 2026-05-31-tauri-packager-bundle-identifier.md
---

# Live UI-testing the WISP dashboard end-to-end: gotchas + the one bug it found

## Problem

An exhaustive "test every button/function as a user" pass over the dashboard (Chrome DevTools MCP) needed to drive React controlled inputs, Radix primitives, a cross-origin-ish preview iframe, and real run controls — and to do it without corrupting the 7 real projects. Several automation behaviours are non-obvious and cost real time; and the pass surfaced one real defect.

## Root cause / findings

**The bug (fixed):** the Run view spammed `GET /api/runs/:id/runtime-report` 404s — `useRuntimeReport` had `refetchInterval: 5000` with no run-state gate, so it polled every 5s for runs that can never have a report (pending/paused/cancelled/failed-before-runtime-verify). Observed 26× 404 on one cancelled run.

## Solution

`useRuntimeReport(runId, runStatus?)` now polls only while `runStatus` is `'running'` or `'completed'` (the only states where a report appears or changes); the single initial fetch still surfaces a report for any run that already has one. `ReleaseGateCard` takes a `runStatus` prop; `RunView` passes `run.status`. No API-contract change. Shipped in v2.0.29; live-verified the spam dropped 26×→1×.

## Key snippets

```ts
// queries.ts — gate the poll, keep the one-shot fetch
const shouldPoll = runStatus === 'running' || runStatus === 'completed';
return useQuery<RuntimeReportRow | null>({
  queryKey: ['runtime-report', runId ?? null],
  enabled: Boolean(runId),
  refetchInterval: shouldPoll ? 5000 : false,
  // queryFn already swallows 404 -> null
});
```

## Verification

Live in the rebuilt bundle: opened the cancelled run, waited 13s, counted `runtime-report` resource requests = **1** (0 new polls), console 404 count 26 → 1. All 9 gates + CI green.

## Lessons (Chrome DevTools MCP ↔ this React app)

- **MCP `fill` / native-setter+`input`/`change` events update React state for text inputs, number inputs, and textareas** (dirty-tracking + Save fire) — **but NOT for native `<select>`**. The AgentOverride model `<select>` never registered the automated change, so the UI "Save" fired the correct `PUT /agent-overrides/:role` with an **empty body**. A real human dropdown selection works fine — this is an automation limitation, not an app bug. For select-dependent flows, verify the endpoint directly.
- **Radix tab triggers and dialog buttons need a real MCP `click`** — a programmatic `el.click()` is a no-op (React synthetic-event delegation). Many plain buttons (goal-edit toggle, DoD/CR delete, run pause/resume) DO fire on `el.click()`.
- **React-Query caches list queries** (e.g. `agent-overrides`): a row created via a direct `fetch` (bypassing the mutation's cache-invalidation) won't appear in a reopened dialog until the query refetches.
- **Browser `confirm()` is auto-accepted by the MCP `evaluate` dialog handler** — a programmatic click on a button guarded by `window.confirm()` deletes silently and you never see the dialog. (This made delete-thread look like it had "no confirm" when it actually does.) Use a real MCP click + `handle_dialog` to observe native confirms.
- **Preview edit-mode element-pick is fully drivable:** real MCP-click the "Bearbeiten" toggle, then the same-origin iframe's elements appear as snapshot uids — MCP-click one and the inspector posts the captured CSS selector + rect back to the parent, opening the "In Queue" panel that creates a `source:'visual'` change-request.
- **Destructive testing without data loss:** open the confirm dialog then cancel (Settings "Alle löschen"), or act on a freshly-created throwaway (new thread → delete it; an unbriefed test project for a run). Reuse an existing orphan **draft** plan to exercise the plan-editor with **no new plan-gen**.
- **`prompt-bundle invalidate` has no confirm** (fires `del.mutate` immediately) — leave the warm cache alone unless you mean it; verify wiring from code, not a live click.

## Follow-up (2026-05-31): "unforceable live" ≠ "untestable"

After the live pass, an adversarial re-audit (4 lenses, each with a skeptic-verify stage) asked the sharper question: of the items I'd deferred as *"can't force through the UI"*, which are actually cheap **integration tests**? Three of six were — and the test DB / temp files force exactly what the live UI couldn't. Shipped tests-only as `cb4f7ef` (server 511→518, no release):

- **Artifact download** (deferred "needs a Tauri build"): the *download* needs Tauri, but the server's `GET /artifact` stream is plain Fastify — seed a temp file + set `artifactPath` in the DB, `app.inject()`, assert 200 + body + `Content-Disposition`. Fastify `inject` buffers a `createReadStream` response into `res.body`.
- **CR `in-run`/`done` filters** (deferred "can't reach those states live"): the lifecycle states are operationally hard to reach, but `PATCH` accepts any `changeRequestStatusValues` — so `POST`→`PATCH` drives the exact transitions the runtime does, then `GET ?status=` proves the `WHERE` is right for every enum value. No raw SQL needed.
- **prompt-bundles route** (= the server half of Settings "clear prompt-bundles", which loops the per-key `DELETE`): seed a row + a throwaway temp `cwd`, `DELETE`, assert 204 + row gone + cwd removed; unknown key → 404; missing-cwd path still deletes the row. **Never point a delete test's `cwd`/path at real data** — `mkdtempSync` or a guaranteed-nonexistent path only.

Two live-pass "findings" the re-audit corrected: the **rate-limit banner UI was already tested** (`RunView.test.tsx` injects a `pausedReason:'rate-limit'` event — only the *server-side 429 detection* is unforceable), and the **Settings "mass-delete data persisted"** was a deliberate confirm-cancel in the live pass, not a bug. Lesson: before filing a live observation as a defect, check whether a unit/integration test already covers it (or whether you just cancelled the dialog).

- **The skeptic-verify stage earns its keep:** 14 raw-"actionable" findings → only 3 confirmed; the skeptics refuted 11 (by-design, already-tested, or not-actually-cheap). For a self-audit of your own "done" claims, a refute-by-default second pass is worth the tokens.
