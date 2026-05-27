# Changelog

## 2.0.17 — Batch-9: frontend WS-vs-REST race + preview-inspector postMessage origin

### Fixed

- **`RunView` no longer re-hydrates from the 5s REST poll while the WebSocket is open** (`apps/dashboard-web/src/routes/RunView.tsx`). The previous effect's dep array included `snapshot.run` and `snapshot.tasks` object refs, which change on every poll — so the store got re-hydrated every 5s, clobbering whatever WS events had arrived since the last poll and producing a visible flicker (task statuses snapping back and forth). The new pattern initial-hydrates once per runId and keeps the REST snapshot as a fallback only while `wsStatus !== 'open'`. Audit F22.
- **`preview-inspector.ts` posts the harness:pick payload to `window.location.origin` instead of `'*'`** (`apps/dashboard-web/src/components/preview-inspector.ts`). The inspector iframe is same-origin with the dashboard via the reverse proxy at `/preview/<projectId>/`, so the strict target works; if the dashboard is ever framed by a third party, that third party no longer receives DOM-inspection payloads (selector + clipped outerHTML + click coordinates). Audit F18.

## 2.0.16 — Batch-8: test gaps + CI gate ordering

### Fixed

- **`ci.yml` runs `pnpm build` BEFORE `Test (unit)`** so `apps/dashboard-server/src/__tests__/serve-web.test.ts` actually executes its 4 assertions instead of silently skipping (`describe.skipIf(!haveDist)`). The 4 tests guarding the `WISP_SERVE_WEB=1` production code path never ran in CI before. Audit T3.

### Added

- **Functional credential-strip test** (`tests/compliance/no-credential-touch.test.ts`). The previous compliance test was a literal source-text grep for `delete env.ANTHROPIC_API_KEY`; a refactor that achieved the same effect via destructure would have passed while the actual subprocess env carried the key. The new test imports the now-exported `buildEnv` (subprocess) and `buildAuthProbeEnv` (auth probe) helpers, sets `process.env.ANTHROPIC_API_KEY` to a sentinel value, and asserts the returned env shape has the key absent. The static grep is retained as a fast canary. Audit T9.
- **Unit tests for `replanOnQAFailure`** (`apps/dashboard-server/src/__tests__/replan.test.ts`). The QA-failure replanner was a P0 gap with zero coverage. New tests cover every early-return path (missing parent plan / missing team / malformed team rolesJson) by inserting minimal DB state and passing a runner that throws on call — proving those paths don't invoke the planner subprocess. Audit T1.

## 2.0.15 — Batch-5/6/7: backend P0/P1 + orchestrator concurrency + agent-overrides wiring

This release closes most of the P0/P1 backlog from the post-v2.0.9 audit.

### Fixed

- **`DELETE /api/projects/:id` now cancels live walkers before the DB cascade fires** (`apps/dashboard-server/src/routes/projects.ts`, `apps/dashboard-server/src/orchestrator/runtime.ts`). New `RunRuntime.cancelRunsForProject(projectId)` walks the resident-walker map, identifies any run whose plan belongs to the project, and cancels each one before Drizzle's FK cascade removes the rows. Without this, deleting an active project left zombie walkers spending Claude API budget against a run row that no longer existed. Backend audit B5.
- **`persistRunPatch` retries once on a transient DB failure**, and if the retry also fails escalates by cancelling the resident walker so it stops emitting events the DB will never see (`runtime.ts`). The original behaviour was a single `console.error` and silent continuation — a permanent DB failure left the run row stuck at `running` forever while the walker kept spending tokens. Audit B23.
- **`cancelRun` rejects with 409 when the run is already terminal** (`runtime.ts`). A double-click on the Cancel button used to overwrite a successfully-completed run's `endedAt` and flip its outcome to `cancelled`.
- **`POST /api/runs/:runId/replay-checkpoint` now returns 501** with an explicit `not_implemented` error instead of 200 with a "not yet implemented in M1-D4" hint (`apps/dashboard-server/src/routes/runs.ts`). Clients misinterpreted the 200 as a successful restore. Audit B3.
- **Walker dispatch re-entrancy** (`packages/orchestrator/src/walker.ts`). The `dispatching` lock used to drop concurrent task-completion wake-ups: when two tasks finished in the same microtask flush, the second `dispatch()` call observed the lock and `return`-ed even if new slots were free. Added a `pendingDispatch` flag that re-fires once on lock release. Audit P1c.
- **`hooks/hooks.json` matcher is now glob `*` instead of regex `.*`**, matching the verified Claude Code v2 hook schema. Both PreCompact and SessionStart entries are updated. Audit L4.
- **Hooks moved off `bash` to `node`** (`scripts/pre-compact-archive.cjs`, `scripts/session-start-cleanup.cjs`, both new). The old shell scripts only ran on machines with a POSIX shell — fresh Windows installs without WSL/Git Bash silently no-op'd both hooks. Cross-platform Node ports preserve the same semantics. Audit L5.
- **PowerShell launcher detaches the dashboard properly** (`scripts/launch-dashboard.ps1`). Replaced `-NoNewWindow` (which tied the server's lifecycle to the launching console group) with `-WindowStyle Hidden` so closing the Claude Code window no longer kills the dashboard. Audit L8.

### Added

- **Per-project agent overrides + handoffs are now consumed by the Walker** (`packages/orchestrator/src/walker.ts`, `apps/dashboard-server/src/orchestrator/runtime.ts`). The `WalkerDeps` interface gains two optional fields:
  - `applyAgentOverride(role, base)` — closure built by the runtime from `loadAgentOverridesForProject`. Lets a project swap a role's model, append an extra system prompt, or union extra `allowed-tools` without touching the team config.
  - `handoffsSection: string` — pre-rendered `## Prior Handoffs` markdown built from `loadHandoffsForProject + renderHandoffsSection`. `composeTaskPrompt` appends it after the retry-context section so a developer task sees what the architect handed off earlier in the same run.

  Both are loaded fresh at every cold walker construction (start-run + cold-resume), so an override edited between pause and resume actually takes effect. Audit B1, B2.

## 2.0.14 — Focusboard polish: cache invalidation + elapsed-timer sync

Two fixes surfaced by a post-implementation review of v2.0.13:

### Fixed

- **Pause / Resume / Cancel mutations now invalidate `project-runs` (and `global-runs`)** in addition to `['run', runId]` (`apps/dashboard-web/src/api/queries.ts`). Focusboard derives its status badge, contextual button visibility, and elapsed-timer guard from `useProjectRuns`, which polls at 5s — without this, clicking Pause/Cancel left the UI showing "läuft" for up to 5 seconds and let users accidentally double-fire mutations during that window.
- **Focusboard elapsed timer now syncs `now` on effect entry** (`apps/dashboard-web/src/routes/Focusboard.tsx`). The `useState(() => Date.now())` initializer only fires at mount; for tabs left open across a status transition, the first paint of an active-run timer could show a value hours stale before the interval ticked. Calling `setNow(Date.now())` before starting the interval fixes the initial frame.

## 2.0.13 — Focusboard: persistent workspace for one active project at a time

A new top-level workspace at `/focus/:projectId?`. Replaces the tab-switching dance in `ProjectDetail` with a persistent, dense layout suited to watching autonomous agent work happen live.

### Added

- **`/focus` and `/focus/:projectId` routes** (`apps/dashboard-web/src/routes/Focusboard.tsx`). The route remembers the last focused project in localStorage (`wisp-focus`) via a new Zustand store (`apps/dashboard-web/src/store/focus.ts`), so reopening the browser lands you back where you left off. A bare `/focus` redirects to `/focus/<storedProjectId>` so the URL is always shareable.
- **Three-column layout filling the full viewport below the topbar:**
  - Left (440px): live KPIs (Tokens-In, Tokens-Out, Turns, Aufgaben done/total), full task list with status-colored left borders, and a footer counter for running/pending/failed tasks.
  - Middle (flex): the existing `<PreviewFrame>` mounted directly — same viewport switcher, edit mode, change-request flow as the project Vorschau tab.
  - Right (300px): `<AgentChat compact={true}>` scoped to the current project, so new threads auto-associate with the focused project.
- **Header bar with inline project picker** and status pill (running / paused / completed / failed / cancelled — color-coded with a live-updating elapsed timer for running runs). Pause/Resume/Cancel actions appear contextually based on run status. "Volle Ansicht" jumps to the legacy ProjectDetail.
- **Sidebar nav entry** (`apps/dashboard-web/src/components/layout/Sidebar.tsx`) with `Crosshair` icon and `data-testid="sidebar-focusboard"`, placed directly below Mission Control.
- **i18n keys**: `navigation.focusboard` in DE/EN. Inline strings still carry German defaults via `t('focus.x', 'fallback')` so the route works before the full focus.* bundle is added.

## 2.0.12 — Full-audit batch 3: orchestrator retry hygiene + resume auth gate

### Fixed

- **`Walker` now resets `transientRetries` when entering a structural retry** (`packages/orchestrator/src/walker.ts`). A task that exhausted its transient-infra retries and transitioned to the structural retry path would still see `transientRetries === MAX_TRANSIENT_RETRIES` on the next subprocess attempt. A single Anthropic 5xx blip on the structural attempt then fell through to a terminal task failure — the task burned its one structural retry on infrastructure noise instead of recovering. Resetting the counter on the structural-retry edge keeps the two retry budgets independent.
- **`resumeRun` now enforces the auth probe gate** (`apps/dashboard-server/src/orchestrator/runtime.ts`). `startRun` already returns 503 `auth-failed` when `WISP_AUTH_MODE=subscription` and the last `claude` auth probe failed, but `resumeRun` and the autopilot tick that delegates to it had no equivalent check. Auth-failed credentials kept resuming runs that would then immediately fail with auth errors on every spawned subprocess, burning retry budget. The 503 path now short-circuits before the walker is resumed.

## 2.0.11 — Full-audit batch 2: chat XSS hardening, real-time polling, WS event cap

Batch 2 of the post-v2.0.9 audit. Closes the high-severity P0 (XSS) and the real-time gap that left agent replies invisible until the user re-sent.

### Fixed

- **XSS via agent names in chat action receipts** (`apps/dashboard-web/src/routes/Chat.tsx`). The i18n bundle uses `interpolation.escapeValue: false` (so static `<strong>{{name}}</strong>` markup in translations renders as HTML); previously the server-supplied agent name was interpolated raw and the result passed to `dangerouslySetInnerHTML`. An agent created with `<img onerror=alert(1) src=x>` as its name would execute arbitrary script. Values are now run through a new `escHtml()` helper in `lib/utils.ts` at every call site (`chat.action.memberAdded`, `chat.action.consulted`, `chat.action.runStarted`).
- **`useThreadMessages` now polls every 3s** (`apps/dashboard-web/src/api/queries.ts`). Without polling, agent replies arriving after the user sent a message were invisible until the user sent another one — the chat felt frozen.
- **`useProjectRuns` now polls every 5s.** PreviewFrame's "reload iframe on run completion" auto-refresh relied on this query to detect a finished run. With no interval the preview showed stale output until the user navigated away and back.
- **WS event buffer is bounded at 2000 entries** (`apps/dashboard-web/src/api/ws.ts`). Long autonomous runs were accumulating tens of thousands of `HarnessEvent` rows into a `useState` array, growing React reconciliation cost linearly with run duration.
- **`useGlobalRuns` + `useRunsSummary` now log fetch failures via `console.warn`** instead of silently returning `[]` / empty summary. A server outage previously presented as "0 runs" — indistinguishable from a healthy quiet state. Also gates `refetchIntervalInBackground: false` on the three Mission Control polling queries so background tabs don't generate continuous traffic.

## 2.0.10 — Full-audit batch 1: manifest URL fields, SPA hardening, WS 404 fix

Outcome of a multi-agent sweep across backend, frontend, packages, tests, and plugin layer. This batch lands the low-risk corrections; orchestrator and observability fixes follow in 2.0.11+.

### Fixed

- **`.claude-plugin/plugin.json` `author.url`** replaces `author.email`. The verified v2 manifest schema specifies `url`; `email` was accepted as a tolerated extra but is non-canonical.
- **`.claude-plugin/marketplace.json` `owner.url`** replaces `owner.email`, and `plugins[0].license: "Apache-2.0"` is now declared explicitly (was missing from the plugin entry; only present at the root manifest level).
- **`apps/dashboard-server/src/ws.ts`** `preValidation` hook now `return`s after `reply.code(404).send(...)`. Without the return, an unknown `runId` would emit the 404 body and *still* attempt the WebSocket upgrade on the same socket, producing a confusing protocol conflict for clients.
- **`KpiSpark` in `apps/dashboard-web/src/routes/Home.tsx`** uses a deterministic gradient ID per tone instead of `Math.random()`. The random ID leaked an orphan `<linearGradient>` node into the SVG DOM on every poll cycle (every 10s).
- **`Settings.clearChats` invalidation** now passes `exact: false` to `qc.invalidateQueries`, so prefix-matching against the longer cache key (`['settings-count', 'chat-threads', agentIds]`) actually invalidates the count after a clear.

### Added

- **`<ErrorBoundary>` wraps `<Outlet />` in `App.tsx`**. Previously an uncaught render exception in any route blanked the entire SPA. The boundary surfaces the error message + an "Erneut versuchen" / "Seite neu laden" action.
- **`/*` catch-all route renders `<NotFound />`** instead of an empty `<main>` content area. Mistyped URLs and stale deep links now get a clear 404 view with a link back to Mission Control.

## 2.0.9 — Plugin manifests aligned with verified Claude Code v2 schema

A focused install-path hardening release. Two P0 schema violations were blocking `claude plugin install wisp` and `claude plugin marketplace add Samuel0101010/wisp-orchestrator` from a clean machine; the plugin appeared installable but failed during validation. v2.0.9 also smooths first-launch by accepting users who have only Node (no global pnpm) installed.

### Fixed

- **`.claude-plugin/plugin.json` `repository` is now a plain string** ([72442ed](https://github.com/Samuel0101010/wisp-orchestrator/commit/72442ed)). The previous npm-style object `{ "type": "git", "url": "..." }` failed Claude Code's manifest validator with `Invalid input: expected string, received object`, blocking `/plugin install` outright.
- **`.claude-plugin/marketplace.json` `plugins[0].source` is now the verified object form** `{ "source": "github", "repo": "Samuel0101010/wisp-orchestrator" }`. The previous bare string `"./"` resolved only against a locally-cloned marketplace dir; `claude plugin marketplace add Samuel0101010/wisp-orchestrator` from anywhere else failed with `expected object, received string`.
- **`commands/wisp-dashboard.md` declares `allowed-tools: Bash(powershell *), Bash(bash *)`** so the first `/wisp-dashboard` invocation doesn't get blocked by the auto-mode classifier or trigger per-call permission prompts. Uses the space-form matcher the schema requires (the `Bash(cmd:*)` colon form silently fails).
- **`scripts/launch-dashboard.{sh,ps1}` fall back to `corepack pnpm`** when pnpm is missing on PATH. Corepack ships with Node ≥16.13, so any user on the documented Node 20+ baseline can build without `npm install -g pnpm` friction.

### Chore

- **`package.json` pins `packageManager: pnpm@10.33.2`** so corepack resolves the same pnpm version the lockfile was generated against (previously the launcher fallback would have used corepack's default).
- **`.github/workflows/ci.yml` pins pnpm to 10.33.2** in both `verify` and `e2e` jobs (was floating on `10`) to match the new `packageManager` field and avoid future strict-equality mismatches.
- **`WISP_Schriftzug.png` moved to `docs/assets/source/`** so the plugin clone Claude Code pulls during `/plugin install` no longer carries a 1280-wide brand source PNG at its root. Only the regen script (`scripts/crop-wordmark.py`) reads it.

## 2.0.8 — Goal-Planer hardening: silent error swallow, dropped actions, misleading buttons

Deep multi-agent audit of the Goal-Planer (GOAP) tab caught a stack of correctness, UX, accessibility, and i18n bugs that all reproduced live in Chrome. Six P0/P1 bugs were silently degrading the experience without any visible signal.

### Fixed

- **New actions added via the JSON editor are now auto-enabled instead of silently dropped from the plan.** Previously `enabled` was seeded once from `EXAMPLE_ACTIONS` and never reconciled with subsequent JSON edits, so a user adding a fourth action would see it in the library but it would never participate in the planner submit.
- **Empty-actions submit no longer leaks a hidden 400.** Server now accepts `actions: []` (returns `[]` when initial satisfies goal, `null` otherwise); client guards on `enabled.size === 0` and renders a friendly "no actions enabled" alert instead of waiting silently for a request that the schema rejects upstream.
- **Mutation errors are now surfaced.** `planM.error` renders next to `parseError` with an `AlertTriangle` + `role="alert" aria-live="assertive"` so a 4xx/5xx/network failure is no longer invisible.
- **"Re-plan" button was a `planM.reset()` in disguise — renamed to "Clear" / "Zurücksetzen"** and disabled when there is nothing to clear. The legacy German `goap.actions.reset` key still exists for backwards compat, but the canonical label is now `goap.actions.clear`.
- **`loadExample()` now calls `planM.reset()` + clears every per-field parse error.** Previously a stale plan continued to render against the freshly-loaded example inputs.
- **Per-field JSON validation lights up the textarea border + `aria-invalid` + "invalid JSON" badge.** Previously invalid JSON silently fell back to `EXAMPLE_ACTIONS` and the canvas showed unrelated data without any inline warning.
- **All controls disable during pending submission** (textareas, checkboxes, filter, Load example) — no more racing the in-flight mutation.
- **Cmd/Ctrl+Enter now submits from anywhere on the route**; focus is moved into the result region on success so keyboard users aren't stranded on the submit button.
- **Canvas now exposes accessible labels.** `aria-label` on the canvas container summarizes the current plan state ("Plan visualization: N steps, cost C"); `aria-live="polite"` on the result region announces completions; `aria-expanded` on the Edit JSON toggle; `role="progressbar"` with `aria-valuenow/min/max` on the header bar.
- **`shortFlag()` surfaces multi-key preconditions/effects as `key +N`** instead of dropping additional keys silently.
- **Overflow chip when actions exceed the canvas budget of 8** — a coral `+N more not shown` badge replaces silent truncation.
- **Progress bar hidden in pre-plan state** instead of rendering a flat 0% bar that looks broken.
- **`summary.cost` fallback now only sums enabled actions** — the pre-plan "est cost" no longer includes the cost of unchecked actions.
- **Defensive parse in `PlanResult`** — a malformed payload (non-array `plan`) now renders a recoverable status instead of crashing the route.
- **Responsive grid** — three columns at `lg`, single column below so narrow viewports don't break the canvas.

### i18n

- Adds all missing `goap.*` keys to both `de` and `en` locales (header eyebrow, world state, stats title/actions/cost/eta/enabled-ratio, actions library, filter, raw editor, canvas overflow/aria, headline computed/satisfied/preview, summary steps/queued/cost/est-cost/no-actions-needed, library no-matches/empty/toggle-aria/cost-suffix, editor invalid-json, errors no-actions-enabled/json-prefix/request-prefix, result title/no-plan/already-satisfied/malformed/cost-inline). EN `goap.subtitleLong` no longer falls back to a German default.

### Chore

- +5 server tests for `/api/goap/plan` (cheapest plan, no-plan, already-satisfied, empty-actions short-circuit, malformed body). Total: 460 server tests, 138 web tests.

## 2.0.7 — notifications bell is no longer a dead button

A wide acceptance sweep across every WISP UI surface (every sidebar section, top-bar control, project tab, project-detail page, command palette, viewport switcher, edit-mode flow) caught one remaining placeholder: the top-bar bell icon had `aria-label="Notifications"` but no `onClick` — it looked interactive but did nothing.

### Fixed

- **Top-bar notifications popover** ([71ace6a](https://github.com/Samuel0101010/wisp-orchestrator/commit/71ace6a)). The bell now opens a popover showing the last 8 global runs across all projects: status pill (running/paused/success/failed/cancelled — running pills go live), project name + run id, relative time anchored to `endedAt ?? startedAt` and snapshotted on open so labels don't churn while the panel is visible, link into each run, footer link to `/insights`. Empty state when no runs. Uses the same outside-click + Escape dismiss pattern as `LanguageToggle` / `SnippetMenu` to stay dependency-free (no new `@radix-ui/react-popover` dep).

### Chore

- +2 web tests (popover opens + lists rows, empty state). Totals: 446 server, 138 web.

## 2.0.6 — preview refresh button + auto-reload after iteration

Closes the last UX gap of the iteration loop: after an iteration writes new code, the proxied iframe needs to see it.

### Added

- **Manual + auto refresh button in the preview header** ([a129532](https://github.com/Samuel0101010/wisp-orchestrator/commit/a129532)). Vite HMR doesn't work through the reverse-proxy (the WebSocket upgrade is not handled). Rather than rebuild a full WS-aware proxy, the simpler fix: a `preview-refresh` button between the viewport switcher and Stop, plus an auto-reload `useEffect` that watches the project's most recent run and reloads the iframe + fires a 3 s toast when it transitions running → completed/success. The visual end-state after an iteration now reflects the new code without the user having to do anything.

### Chore

- +2 web tests (refresh button click + auto-reload-on-completion). Total: 136 web tests, 446 server tests.

## 2.0.5 — visual-edit inspector was talking to itself, now talks to the parent

One fix from the user-acceptance sweep that came right after v2.0.4. The visual-edit-mode (click an element in the preview iframe → write a change-request against that element) appeared to be installed correctly — the inspector script reaches the iframe, the overlay markup is in place, the parent listens for messages — but clicking an element did nothing. No selection panel, no event, no error.

### Fixed

- **Inspector ↔ parent message kinds are now consistent**. The injected inspector script emitted `wisp:pick` and listened for `wisp:set-edit-mode`. The parent (PreviewFrame.tsx) emits `harness:set-edit-mode` and listens for `harness:pick`. The two halves never agreed on which event to fire. Every click in edit-mode was silently dropped. Caught by live test: click → 0 pick events on parent → no selection panel rendered. Fixed both kinds to `harness:*` matching the parent contract. Verified live: click in iframe → selector `aside.w-60 > nav.flex-1 > div.group > span.flex:nth-of-type(2) > button` captured, selection panel renders, prompt submission persists the change-request with `source: 'visual'`.

## 2.0.4 — iteration loop made visible, preview iframe actually renders

Two fixes from a deep user-test of the iteration workflow — the loop that turns "preview the app, write change-requests, regenerate the plan" into the canonical path for improving an existing project.

### Fixed

- **Preview iframe now actually renders the app** ([de5d0e3](https://github.com/Samuel0101010/wisp-orchestrator/commit/de5d0e3)). The preview proxy got the HTML through correctly (200 with the FocusBoard title) but the React app never hydrated. Vite emits absolute paths for its dev client and source modules — `<script src="/src/main.tsx">` — and the browser fetched those against the dashboard origin (`localhost:4400/src/main.tsx`), not the proxy. The dashboard's SPA fallback either returned its own index.html or 404'd, depending on the path. Fix: vite is now launched with `--base /preview/<projectId>/` (only for frameworks that respect it — `vite` and `@sveltejs/kit`; next/nuxt would error on the flag) and the reverse-proxy forwards the full URL upstream instead of stripping the prefix. The whole vite asset graph now resolves through the proxy. Live-verified: `/preview/<id>/@vite/client` returns the real 139 KB vite dev client, `/preview/<id>/src/main.tsx` returns the 2.4 KB module, React hydrates, FocusBoard renders.

- **"Iteration starten" now shows that it's actually doing something** ([76de415](https://github.com/Samuel0101010/wisp-orchestrator/commit/76de415)). Clicking "Iteration starten" disables the button to `Wird gestartet…` and… nothing for 1–3 minutes, while the LLM regenerates the plan. No spinner, no toast, no progress indicator — verified live at 2+ minutes of frozen UI before the new run finally appeared. Now: an immediate long-duration toast fires on click ("Iteration wird vorbereitet … Plan wird basierend auf deinen Änderungen neu generiert. Das kann ein bis zwei Minuten dauern."), and the button text grows an elapsed-seconds counter (`Iteration wird vorbereitet … (47s)`) updating every second from a `Date.now()` baseline that's resistant to tab-throttling. Toast is dismissed on settle; the existing success/error toasts replace it.

### Chore

- 5 new tests across `preview-server.test.ts`, `detect-project-type.test.ts`, and `PendingChangesPanel.test.tsx`. Total: 450 server tests, 134 web tests.
- New `framework` field on the project-type detection result exposes which web framework was detected — drives the basePath whitelist and is a useful general primitive.
- `toast()` API now accepts an optional `duration` and returns the toast id; new `dismissToast(id)` companion.

## 2.0.3 — dashboard UX hardening from a live user-test session

Three fixes that emerged during a live Chrome-MCP user-test of the dashboard against the FocusBoard project. Each one closes a specific friction point a real user hit — empty error states, silent failures, missing affordances.

### Fixed

- **Preview tab is honest about failure** ([b400264](https://github.com/Samuel0101010/wisp-orchestrator/commit/b400264)). The preview spawned `pnpm dev` against a hardcoded port from the project's probeUrl (usually `:5173`). When the port was held by a stale process from a prior session, vite crashed early but the UI stayed on "STARTET" until the 60-second timeout — no progress, no error, no clue why. Three changes: (1) `preview-server.ts` now probes `isPortFree()` before spawning and scans `port..port+10` for a free slot, rewriting both `env.PORT` and the probeUrl so the readiness poll hits the right endpoint; (2) `getPreviewStatus()` runs `process.kill(pid, 0)` against the registered child — a dead pid mutates the entry to `status: "error"` with `errorReason: "process-died"` so the UI no longer reports "running" against a zombie; (3) `PreviewFrame.tsx` shows a 1-second-ticking "läuft seit Ns" counter while starting and an inline `role="alert"` with the actual error string when the poll arrives in error state. Default timeout 60s → 30s — interactive UX feels broken at the longer wait.

- **Cancelled tasks are cancelled, not failed** ([fd0c925](https://github.com/Samuel0101010/wisp-orchestrator/commit/fd0c925)). Clicking "Run abbrechen" cascaded every pending/running task into the FEHLGESCHLAGEN bucket — indistinguishable from a real crash. Caught during a FocusBoard cancel test where seven tasks ended up red because the user changed their mind. Now: `taskStatusValues` adds `'cancelled'`; `Walker.cancel()` writes `cancelled` (not `failed`) on the explicit cancel path; runtime's `TASK_STATUS_MAP` passes it through; the run-store reconciles `run.completed` with `outcome: 'cancelled'` by retroactively flipping not-yet-terminal tasks to `cancelled`; `RunView.tsx` shows a sixth "ABGEBROCHEN" bucket with a `Ban` icon. The cascade for upstream-dep-failures still writes `failed` — those tasks died because something else broke, not because the user said stop. Drive-by: removed Radix's auto-rendered corner-X close button from confirm dialogs (it duplicated "Abbrechen"); Esc and overlay-click still dismiss.

- **"Neuen Run starten" asks before it commits** ([f9eb7c4](https://github.com/Samuel0101010/wisp-orchestrator/commit/f9eb7c4)). Clicking the button immediately POSTed `/api/runs` and navigated away — no confirmation, no goal preview, no hint that the iteration pattern (preview tab → change-requests → "Iteration starten") exists for the "verbessern/erweitern" case. New `RunStartDialog.tsx` modal renders the current goal (truncated to 300 chars with expand toggle), an info banner with a "Zur Vorschau" CTA that switches to the preview tab, and the actual confirm/cancel footer. Wired into both the Plan & Team tab AND a new `[data-testid="runs-card-new-run"]` button in the Runs tab — the latter was the missing affordance that made users hunt for run-start on the wrong tab.

### Chore

- 8 new tests across `preview-server.test.ts`, `PreviewFrame.test.tsx`, and `RunStartDialog.test.tsx`. Total: 441 server tests, 131 web tests.

## 2.0.2 — reliability hardening from a real app-build session

Five fixes that emerged during a session where the plugin built two complete React apps end-to-end. Each one closes a specific failure mode observed live — not a theoretical edge case. Together they make a multi-hour autonomous run substantially harder to derail.

### Fixed

- **Subprocess tree-kill on Windows + POSIX** ([a808707](https://github.com/Samuel0101010/wisp-orchestrator/commit/a808707)). `child.kill(signal)` only signalled the immediate `claude` CLI parent. Long-lived grandchildren spawned by tasks (`pnpm preview`, `vite`, Chromium) survived on POSIX and especially on Windows, where there is no signal propagation. After a Stratos run completed days earlier, its `vite` was still bound to port 5173 — a stale dev server serving outdated source the user noticed as a "boot:fail" black screen. Now: Windows `taskkill /T /F`, POSIX `process.kill(-pid, signal)` against the spawned process group, matching the pattern already used in `boot-smoke.ts` / `preview-server.ts`.

- **`core.longpaths=true` on auto-commit git calls** ([0b01994](https://github.com/Samuel0101010/wisp-orchestrator/commit/0b01994)). Tasks that installed deeply-nested pnpm deps (`@dnd-kit`, `@radix-ui`) crashed in the post-task auto-commit with `git add -A` "could not open directory 'node_modules/.pnpm/@dnd-kit+core@…'" — Windows `MAX_PATH` exhaustion. Caught live on a FocusBoard scaffold task that succeeded with exit 0 but cascade-failed all six downstream tasks. Promoted `core.longpaths=true` from optional user-config to a per-invocation `-c` flag inside `commitWorktreeChanges`.

- **Release-gate trusts `runtime-verifier` boot evidence** ([2b3a7bf](https://github.com/Samuel0101010/wisp-orchestrator/commit/2b3a7bf)). The verifier proved boot worked live (`pnpm preview` + Playwright + HTTP 200), wrote a `runtime-report.json` with `boot.ok: true`, then the release-gate ran a fresh re-probe at a moment when no preview server was alive and reported `Boot: FAIL`. Result: green run with a red "Release-Gate FEHLER" badge — contradiction visible in the FocusBoard run UI. Gate now reads `runtime.boot.ok` first and only falls back to live re-probe when no evidence exists.

- **Smart per-task inactivity watchdog** ([9c92e0c](https://github.com/Samuel0101010/wisp-orchestrator/commit/9c92e0c)). The 10-min idle watchdog killed `n3-store` mid-work because the LLM was doing a long thinking pause with no token stream — the subprocess was alive and the work was real. Default bumped to 15 min. Before killing, the watchdog now `process.kill(pid, 0)`-probes liveness and reads the subprocess CPU time (POSIX `ps`, Windows `Get-Process`); if alive + CPU advancing, extends the grace period up to 25 min total. Falls back to immediate kill only when the process is genuinely dead or stuck.

- **Crash-resilient logging + WAL checkpoint on shutdown + startup banner** ([1fe24ef](https://github.com/Samuel0101010/wisp-orchestrator/commit/1fe24ef)). After a 3-hour run, the dashboard server's `%TEMP%/wisp-todo-v2-run/server.out.log` contained exactly one line — Node's stdout buffer ate hundreds of request logs and the crash stack on hard exit. Separately, hard-killing the server during restart left the SQLite WAL un-checkpointed and projects appeared missing on next boot. Fixes (one commit): pino multistream over stdout **plus** a sync file destination at `{WISP_DATA_DIR}/logs/server.log` (every line flushed before the call returns); `SIGTERM`/`SIGINT`/`beforeExit` handlers run `server.close → flushLogs → PRAGMA wal_checkpoint(TRUNCATE) → db.close → exit`, each step try/caught, single-shot latch; `uncaughtException` + `unhandledRejection` write to `crash.log`; startup banner logs resolved `WISP_DATA_DIR`, DB path + size, project / runs counts, listening address — so a misconfigured restart is visible in the first line of output.

### Chore

- Added `.claude/worktrees/**` to eslint ignore patterns to keep subagent-isolation worktrees out of the lint sweep.

## 2.0.1 — WISP rebrand · ship-ready release

The plugin is now **WISP**, end-to-end. Same orchestrator, same plan-as-artifact discipline, but renamed across every layer so the brand is consistent from `claude plugin install wisp@wisp-local` down to the MCP server name the spawned agents see.

### Breaking — identifier rename

- **Plugin marketplace ID** `agent-harness` → `wisp`. Install command is now `claude plugin install wisp@wisp-local`. Marketplace name `agent-harness-local` → `wisp-local`. Existing installs at `agent-harness@agent-harness-local` are orphaned; uninstall the old one and reinstall the new.
- **npm scope** `@agent-harness/*` → `@wisp/*` across all five workspace packages (`orchestrator`, `dashboard-server`, `dashboard-web`, `schemas`, `memory-mcp`). All cross-package imports + every `pnpm --filter` invocation updated.
- **Env vars** `HARNESS_*` → `WISP_*`: `WISP_PORT`, `WISP_HOST`, `WISP_DATA_DIR`, `WISP_LOG_LEVEL`, `WISP_CORS_ORIGIN`, `WISP_MOCK_CLI`, `WISP_SERVE_WEB`, `WISP_INTER_TASK_PACING_MS`, `WISP_AUTO_RESUME_RATE_LIMIT`, `WISP_AUTH_MODE`, `WISP_HOOK_TOKEN`, `WISP_MEMORY_DB`, `WISP_E2E_*`. No fallback — update your `.env.local`.
- **Slash commands** `/harness-*` → `/wisp-*`: `/wisp-dashboard`, `/wisp-new-run`, `/wisp-resume`, `/wisp-inspect`, `/wisp-diagnose`. Skill directories renamed accordingly.
- **MCP server name** `agent-harness-memory` → `wisp-memory`. Tools spawned agents call: `mcp__wisp-memory__memory_set/get/list/delete`.
- **Default data dir** `os.tmpdir()/agent-harness` → `os.tmpdir()/wisp`. **Existing runs/projects under the old default are stranded** — move them manually if you need the history, or set `WISP_DATA_DIR` explicitly.
- **Playwright browser cache** `~/.cache/agent-harness/playwright-browsers` → `~/.cache/wisp/playwright-browsers`. First runtime-verify after upgrade re-downloads Chromium once.
- **Internal**: commit-message prefix `harness: <task-id>` → `wisp: <task-id>`. Worktree branch prefix `harness/<role>` → `wisp/<role>`. Committer email `harness@agent-harness.local` → `wisp@wisp.local`. localStorage key `agent-harness-ui` → `wisp-ui` with one-time auto-migration so theme, sidebar-collapsed state, and favorites survive the upgrade.
- **GitHub repo** `Samuel0101010/agent-harness` → `Samuel0101010/wisp-orchestrator` (the bare `wisp` slug was taken by a different project). GitHub redirects old URLs permanently.

### Added — design + features

- **Wisp design system** ([PR #43](https://github.com/Samuel0101010/wisp-orchestrator/pull/43)) — warm cream/black palette, Instrument Serif/Sans + JetBrains Mono fonts, coral accent, aurora background, glass-tinted sidebar. Every page (Mission Control, Chat, Agents, Skills, Workers, Insights, Goal Planner, Prompt Bundles, Run View, Project Detail) re-skinned 1:1 against the Claude Design handoff.
- **Sidebar 3-dot project menu** ([PR #48](https://github.com/Samuel0101010/wisp-orchestrator/pull/48), [#51](https://github.com/Samuel0101010/wisp-orchestrator/pull/51)) — hover-revealed `MoreHorizontal` button per project row opens a portal-rendered dropdown with "Mark as favorite" + "Delete". Favorites sort to the top and persist via zustand. Delete opens a confirmation dialog and calls the new `DELETE /api/projects/:id` endpoint. Portal renders to `document.body` with `position:fixed` + z-index 1000 so the menu never bleeds through neighbouring project rows.
- **Settings page** at `/settings` ([PR #48](https://github.com/Samuel0101010/wisp-orchestrator/pull/48)) — central place for theme + language + sidebar-collapsed default, plus selective data clearing across nine categories (Projects, Chat threads, Custom agents, Prompt bundles, Agent overrides, Change requests, DoD criteria, Insights, Runs). Each row shows a live count and a "Clear all" button with confirmation. Runs is intentionally read-only because the server has no DELETE for runs.
- **Plan-budget label fix** — sidebar footer renamed from misleading "Plan budget · today" / "N runs" to consistent "Runs · today" / "N runs".
- **README dashboard tour** ([PR #48](https://github.com/Samuel0101010/wisp-orchestrator/pull/48)) — 9 dashboard screenshots embedded (Mission Control, Chat, Agents, Skills, Workers, Insights, Goal Planner, Prompt Bundles, Settings). Capture script at `scripts/capture-readme-screenshots.mjs`.

### Server

- **`DELETE /api/projects/:id`** — new endpoint, cascade via FK constraints. Backs the sidebar delete action.

### Verification

- 421 unit tests pass, 51 e2e specs pass, lint/format/typecheck/validate-tokens all clean across the rebrand PR chain (#43–#51).

## 2.0.0-rc — Complete production loop · Lead agent (Phase 8)

This is the milestone release where the "Plan → Run → Preview → Iterate
→ Build → Lead" production loop is feature-complete end-to-end.

The Team Lead (Theo) closes the last gap: a read-only role whose only job
is to look at the whole project — brief, current state, last run's events,
open change-requests, prior hand-offs and prior lead notes — and decide
what should happen next. V1 ships as **manual ticks only**: the user clicks
"Tick now" in the Brief tab and Theo emits a structured `<<LEAD_DECISION>>`
directive that the dashboard renders as a card with a `recommendedAction`
badge (continue / replan / wait-for-user), a `nextRole` hint, and any
blockers Theo identified. V1 emits replan recommendations; auto-triggered
replans land in v2.1.

### Added (Phase 8 — Lead Agent)

- **Migration `0018_lead_notes.sql`** — new `lead_notes` table (id,
  project_id FK with `ON DELETE CASCADE`, run_id, summary_md,
  decisions_json, triggered_run_id, created_at + two indexes) plus
  `projects.lead_enabled INTEGER NOT NULL DEFAULT 0`. Both statements
  separated by `--> statement-breakpoint` so the migrator runs them as
  discrete operations.
- **`packages/schemas/src/lead.ts`** — `leadDecisionSchema` (Zod, strict)
  + `parseLeadDecisionFromText` directive parser mirroring `brief.ts`.
  Tolerant of plain text, invalid JSON, unknown fields, and unterminated
  blocks; the cleaned reply has the directive stripped so the UI doesn't
  render raw machine markers.
- **`packages/schemas/src/db.ts`** — `leadNotes` Drizzle table object,
  `LeadNote` / `NewLeadNote` row types, `LeadDecisionsJson` /
  `LeadRecommendedAction` shape types, and `projects.leadEnabled` boolean
  column. Re-exported from the package barrel.
- **Seed agent `lead` (Theo, opus, `#8B5CF6`)** in
  `apps/dashboard-server/src/db/agents-seed.ts` — read-only allowlist
  (`Read`, `Grep`, `Glob`), ~2500-char system prompt that teaches the
  workflow, hard rules, and the `<<LEAD_DECISION>>{...}<<END>>` directive
  grammar. Seeder remains idempotent.
- **`apps/dashboard-server/src/orchestrator/lead-runner.ts`** (new) —
  `runLeadTick({ projectId, runId?, turnImpl?, runner?, dataDirOverride? })`.
  Loads the context bundle from the DB (project, brief, latest
  project-state, latest run + last 50 events, open change-requests, prior
  handoffs via `loadHandoffsForProject`, prior lead notes), composes a
  sectioned prompt, calls Theo via `runAgentTurn`, parses the directive,
  and persists a `lead_notes` row. Returns `{ noteId, summary, decision,
  parseError, tokensIn, tokensOut, durationMs, failed }`.
- **`apps/dashboard-server/src/routes/lead.ts`** (new) — `createLeadRouter`
  factory wiring four endpoints registered after `buildRoutes`:
  `POST /api/projects/:projectId/lead/tick` (412 `lead_disabled` when the
  flag is off, 404 when project missing), `GET /lead/notes?limit=N`
  newest-first, `GET /lead/notes/:id`, `DELETE /lead/notes/:id` (204).
- **`apps/dashboard-server/src/orchestrator/inject-lead-checkpoint.ts`**
  (new) — `injectLeadCheckpoint({ plan })` mirrors
  `inject-runtime-verifier.ts`. Idempotent, refuses at the 8-role team
  cap, wires the new `n-lead-checkpoint` node behind every terminal node.
  Plugged into `routes/plans.ts` AFTER the runtime-verifier injection,
  gated by `project.leadEnabled`.
- **`apps/dashboard-server/src/routes/projects.ts`** — PATCH route accepts
  `leadEnabled?: boolean`, applied via the existing partial-update
  refinement.
- **`apps/dashboard-web/src/api/queries.ts`** — `LeadDecisionsJson`,
  `LeadNoteRow`, `LeadTickResponse` types; `useLeadNotes(projectId, limit)`
  (refetchInterval 30s); `useLeadTick(projectId)` with optional `runId`;
  `useDeleteLeadNote(projectId)`; `UpdateProjectInput.leadEnabled?`.
- **`apps/dashboard-web/src/components/LeadNotesCard.tsx`** (new) —
  rendered inside the Brief tab below `ProjectStateCard`. Toggle "Activate
  lead" when the flag is off (patches `leadEnabled: true`), "Tick now"
  button when on (disabled while pending), expandable list of the most
  recent 5 notes with colour-coded `recommendedAction` badges,
  `nextRole` chips, blocker chips, delete affordance, and an empty
  state. `data-testid`s: `lead-notes-card`, `lead-tick-button`,
  `lead-activate`, `lead-note-{id}`, `lead-decision-{action}`.
- **EN + DE translations** under `leadNotes.*` (title, description,
  activate, tickNow, ticking, empty, blockers, nextRole, expand/collapse,
  recommendedAction.{continue, replan, wait-for-user}, status badges,
  toasts).

### Behaviour

- V1 lead-driven replan is recommendation-only: when Theo returns
  `recommendedAction: 'replan'`, the note carries the recommendation and
  the user acts on it manually. Auto-spawn lands in v2.1.
- Lead is NOT wired into the walker's between-task lifecycle. Triggers
  are explicit (`POST /lead/tick` or the dashboard button).

### Tests

- `packages/schemas/src/lead.test.ts` — 8 tests covering empty text,
  valid directive parsing, invalid JSON, unknown fields under strict
  mode, invalid enum, unterminated block, multi-paragraph round-trip,
  minimal-shape acceptance.
- `apps/dashboard-server/src/__tests__/lead-runner.test.ts` — 4 tests
  asserting happy-path persistence, parseError fallback, empty-project
  prompt composition, and `project_not_found` error.
- `apps/dashboard-server/src/__tests__/lead-routes.test.ts` — 6 tests
  covering 412 / 404, happy POST, newest-first listing, single-row GET,
  DELETE, and PATCH `leadEnabled` plumbing.
- `apps/dashboard-server/src/__tests__/inject-lead-checkpoint.test.ts` —
  5 tests covering injection, idempotence, team-cap refusal, plan-empty,
  and multi-sink wiring.
- `apps/dashboard-server/src/__tests__/migrations.test.ts` — `lead_notes`
  table existence assertion + `projects.lead_enabled` column assertion.
- `apps/dashboard-web/src/components/LeadNotesCard.test.tsx` — 3 tests
  covering activate button, prior-notes rendering, and tick → POST →
  new-note round-trip.

### The journey from v1.8 → v2.0

- v1.9 — Requirements interviewer (Sarah) + brief gate.
- v1.10 — Project state + iteration planner.
- v1.11 — Preview tab with reverse-proxy iframe.
- v1.12 — Visual edit + change-request queue.
- v1.13 — Per-project team org-chart.
- v1.14 — Agent communications upgrade (memory-mcp scope + handoff helpers + per-project overrides).
- v1.15 — Native packaging (Tauri) + CI hotfix.
- v2.0 — Lead Agent (Theo) coordinating the loop.

## 1.15.1 — CI hotfix

Fixes two pre-existing CI failures that landed on main during Phases 3–7
but were missed because local gates were green:

### Fixed
- Typecheck on a fresh CI checkout (TS2307: `@wisp/memory-mcp`)
  because the workflow ran `pnpm typecheck` before `pnpm build`. Added a
  `Build shared packages` step that produces `packages/**/dist/` first,
  and tightened `handoff-loader.ts` callback types to clear 4 TS7006
  implicit-any warnings.
- e2e Playwright smoke broke after the v1.9 brief-gate started returning
  412 `brief_not_ready` on `POST /api/projects/:id/plan`. Updated
  `tests/e2e/smoke.spec.ts` and `tests/e2e/wave3.spec.ts` to call
  `POST /api/projects/:id/interview/finalize` before clicking Generate
  Plan so the gate passes.
- `tokens:check` violations from Phases 4–5: replaced two `text-[Npx]`
  arbitrary-Tailwind values with the closest token (`text-xs`) and
  added two files to the validator allowlist — `preview-inspector.ts`
  (injected into the preview iframe; can't reach our CSS vars) and
  `OrgChartView.test.tsx` (snapshot fixture asserting a literal hex).

## 1.15.0 — Native packaging (Tauri) (Phase 7)

Closes the "I built it, now how do I ship it?" gap. Until now the harness
ended a run with a green branch in the user's repo. v1.15 adds an opt-in
post-success step that turns that branch into a real native installer (MSI
on Windows, DMG on macOS, AppImage / DEB on Linux) and exposes a one-click
download from the dashboard. The agent role (`packager` / Riley) is seeded
for parity with the rest of the team, but the v1 happy path doesn't go
through a Claude subprocess — the build runs through a dedicated, testable
runner that shells out to `pnpm tauri build` directly.

The trade-offs are deliberate and explicit:

- **Synchronous build endpoint.** `POST /api/projects/:id/build` blocks
  until the build finishes. A native build can take 30s–5min; that's fine
  for v1 with one user at a time. No new tables, no background workers.
- **`sha256` is informational, computed via `fs.readFileSync`.** That is
  safe up to ~500MB installers on a developer workstation. Streaming hash
  is on the v1.15.x list if real-world installers grow.
- **Only `tauri-exe` is implemented.** The other `packageTarget` values
  (`electron-exe`, `pkg-bin`) ship as radio-button placeholders in the
  Settings tab with a "not implemented in v1.15" hint so users see the
  roadmap without being able to trip over half-built code paths.

### Added

- **`apps/dashboard-server/src/orchestrator/packager-runner.ts`** (new) —
  `runPackager({ projectId, runId, repoPath, packageTarget, execImpl?,
  dataDirOverride? })` returns a typed `PackagerResult`. Pipeline:
  probe `tauri --version` → probe `cargo --version` → scaffold
  `src-tauri/` if missing (`tauri init --ci`) → `pnpm build` → `pnpm
  tauri build` → recursive bundle-dir sweep for the first `.msi` /
  `.exe` / `.dmg` / `.appimage` / `.deb` / `.rpm` → copy under
  `<dataDir>/artifacts/<projectId>/<runId>/<basename>` → write
  `docs/build-manifest.json`. Every shellout flows through an `execImpl`
  seam so unit tests never invoke `cargo`. Foreseen failure modes
  (`tauri_cli_missing`, `rust_toolchain_missing`, `web_build_failed`,
  `tauri_build_failed`, `artifact_not_found`, `unsupported_target`)
  return `ok:false` instead of throwing.
- **`apps/dashboard-server/src/routes/build.ts`** (new) — three routes
  registered after `agentOverridesRoutes`:
  - `POST /api/projects/:projectId/build` — preconditions check (project
    exists, `packageTarget != 'web'`, ≥1 successful run, no pending
    change-requests), then calls `runPackager` synchronously. On success
    persists `projects.artifact_path`. On `ok:false` returns 422 with
    the typed result body. On pending change-requests returns 409.
  - `GET /api/projects/:projectId/build/status` — returns
    `{ artifactPath, packageTarget, recentBuild }`. `recentBuild` is an
    in-process cache of the last result; not persisted.
  - `GET /api/projects/:projectId/artifact` — streams the installer
    with `Content-Disposition: attachment`. Uses `fs.createReadStream`,
    so 200MB+ installers don't OOM the server.
- **`apps/dashboard-server/src/db/agents-seed.ts`** — new seed `packager`
  (Riley, sonnet, orange) with a Tauri-focused system prompt + a
  scoped `Bash(pnpm:*, npm:*, npx:*, cargo:*, tauri:*, git:*, node:*)`
  allowlist. Seed is idempotent — re-runs refresh the prompt/description.
- **`apps/dashboard-server/src/routes/projects.ts`** — PATCH accepts a
  new `packageTarget` field, validated against the existing
  `packageTargetValues` enum from `@wisp/schemas`.
- **`apps/dashboard-web/src/api/queries.ts`** — `PackagerResult`,
  `PackagerError`, `PackageTarget`, `BuildStatusResponse` types plus
  `useBuildStatus` (5s refetch), `useStartBuild`, and
  `useDownloadArtifact` hooks. `UpdateProjectInput` gains `packageTarget`.
- **`apps/dashboard-web/src/components/BuildAppCard.tsx`** (new) —
  Settings-tab card that renders the build button, status badge,
  artifact basename + size + sha-prefix, and a Download button. Button
  disables with localized tooltips: "Needs ≥1 successful run", "Resolve
  N pending change-request(s) first", "Build already in progress". On
  failure toasts a localized hint per `PackagerError`. data-testids:
  `build-app-card`, `build-app-button`, `build-app-download`,
  `build-status`, `build-error`.
- **`apps/dashboard-web/src/components/BuildTargetSelect.tsx`** (new) —
  4-option radio group with a "not implemented in v1.15" hint on the
  electron/pkg rows. Saves via the existing `useUpdateProject`.
  data-testid prefix: `build-target-option-<value>`.
- **`apps/dashboard-web/src/routes/ProjectDetail.tsx`** — Settings tab
  now renders `BuildTargetSelect` + `BuildAppCard` below the existing
  Production-Modus-Karte.
- **i18n** EN + DE under `buildApp.*` — `title`, `description`,
  `disabledHint`, `status.*`, `disabled.*`, `actions.*`, `errors.*`
  (one entry per `PackagerError` code), `toasts.*`, `target.*`.
- **`scripts/doctor.mjs`** — two new non-fatal checks: `cargo --version`
  with a "Install Rust: https://rustup.rs" hint, and `pnpm exec tauri
  --version` with a "pnpm add -g @tauri-apps/cli" hint.

### Tests

- **`apps/dashboard-server/src/__tests__/packager-runner.test.ts`** —
  7 cases using a mocked `execImpl`: tauri-cli missing,
  rust-toolchain missing, web-build failure, unsupported target,
  happy path (creates a fake installer in the bundle dir, runner
  copies it to a temp dataDir, asserts sha256 / size / manifest),
  artifact-not-found, idempotent re-run overwrites the destination
  with new content + new sha256.
- **`apps/dashboard-server/src/__tests__/build-route.test.ts`** —
  8 cases injecting a fake packager: 404 unknown project, 400 web
  target, 400 no-successful-run, happy 200 + artifactPath persisted,
  422 packager failure, 409 pending change-requests, GET /build/status
  shape, GET /artifact 404 when unset.
- **`apps/dashboard-web/src/components/BuildAppCard.test.tsx`** —
  4 cases: web-target renders the disabled copy, pending change-
  requests disable the button (count shown), missing successful run
  disables the button, happy path POSTs `/build` once and the
  Download button + basename appear in the DOM.

CI: 403 server / 120 web / 45 schemas / 33 memory-mcp / typecheck clean /
lint clean / prettier clean.

## 1.14.0 — Agent communications upgrade (Phase 6)

Closes three gaps in how agents communicate across a run: memory was per-run
only (so the architect's spec evaporated the moment the run ended), hand-offs
between roles had to travel through the agents' chat windows (where they
were truncated or forgotten), and the team's per-role behaviour was locked
to the shared `/agents/*.md` system prompts (no way to say "for THIS project,
the developer should also call npm-audit"). Phase 6 lays the foundation for
all three:

- **Project-scoped memory** in `memory-mcp`. Every `memory.{set,get,list,delete}`
  tool gains an optional `scope` field. `scope='run'` keeps the v1.13
  behavior (per-run SQLite file). `scope='project'` resolves to a separate
  per-project DB at `<dataDir>/memory/project-<projectId>.db` that survives
  across runs of the same project. The MCP server picks up `HARNESS_PROJECT_ID`
  + `WISP_DATA_DIR` from the subprocess env that the dashboard-server
  exports via `writeMemoryMcpConfig`. A small in-process LRU keyed by db
  path avoids reopening the same SQLite file on every tool call.
- **Hand-off helpers** (`loadHandoffsForProject` + `renderHandoffsSection`)
  exposed by `apps/dashboard-server/src/orchestrator/handoff-loader.ts`. They
  read every `handoff/*` row from the per-project memory DB and render them
  as a `## Prior Handoffs` markdown section the walker can append to the
  next task's composed prompt. The walker wiring itself is deferred to
  v1.14.x — the helpers are well-tested today; full wiring lands once the
  `WalkerDeps` signature gains `projectId` + `dataDir` fields. The
  `phase-6-followup` comments mark the integration points.
- **Per-project agent overrides** — a full CRUD on `project_agent_overrides`
  (table exists since the v1.9 Phase 0 migration) and a click-to-edit dialog
  inside the OrgChartView. The user can swap a role's model, append an
  extra system prompt, widen the allowed-tools list, and assign a shared
  memory namespace. The merge utility (`applyAgentOverride`) is exported
  for the walker; runtime consumption is the same Phase-6 follow-up as the
  hand-off injection.

The trade-off is explicit: the user-visible surface ships today (project
memory works, hand-off helpers are usable from any server-side code, CRUD
+ UI work end-to-end), but the walker doesn't yet auto-write hand-offs or
auto-merge overrides — those land in v1.14.x once we agree on the walker
constructor surface. Marked clearly in code with `phase-6-followup` notes.

### Added

- **`packages/memory-mcp/src/store.ts`** gains `resolveStore({ scope,
  runDbPath, dataDir, projectId })` + `resolveProjectDbPath({ dataDir,
  projectId })` + `closeAllStores()`. The internal `cachedStore` LRU caps
  at 8 entries — plenty for one short-lived task subprocess. New
  `entries()` method on `MemoryStore` returns `(key, value, updated_at)`
  triples ordered by `updated_at`; used by the hand-off loader.
- **`packages/memory-mcp/src/project-store.ts`** (new) — thin
  `writeProjectMemoryEntry` / `readProjectMemoryEntries` helpers for
  callers outside the MCP server process (the dashboard-server walker
  writes hand-offs straight through these instead of round-tripping the
  stdio transport).
- **`packages/memory-mcp/src/tools.ts`** — every tool input schema gains
  an optional `scope: 'run' | 'project'` field (default `'run'`). The
  handler signature changed from `(store, args)` to `(resolve, args)`;
  the server constructs the resolver once from env and threads it through.
- **`apps/dashboard-server/src/orchestrator/mcp-config.ts`** — accepts a
  new `projectId` field. When set, the generated MCP config exports
  `HARNESS_PROJECT_ID` + `WISP_DATA_DIR` in the memory-mcp env block
  so the per-task subprocess can resolve the right project DB.
- **`apps/dashboard-server/src/orchestrator/handoff-loader.ts`** (new) —
  `loadHandoffsForProject` + `renderHandoffsSection`. Skips malformed
  rows, caps results at 15 by default (configurable via `limit`), renders
  oldest-first as `- **role** (taskId): <short prompt>` bullets.
- **`apps/dashboard-server/src/orchestrator/agent-overrides.ts`** (new) —
  `loadAgentOverridesForProject(projectId)` returns a role→merge map.
  `applyAgentOverride(base, override)` is a pure function the walker can
  call per task to merge.
- **`apps/dashboard-server/src/routes/agent-overrides.ts`** (new) — CRUD
  endpoints `GET /api/projects/:projectId/agent-overrides`, `GET .../`
  `:role`, `PUT .../:role` (upsert via `INSERT ... ON CONFLICT DO
  UPDATE`), `DELETE .../:role`. Registered after `orgChartRoutes`.
- **`apps/dashboard-web/src/api/queries.ts`** — `AgentOverrideRow` type,
  `useAgentOverrides`, `usePutAgentOverride`, `useDeleteAgentOverride`.
- **`apps/dashboard-web/src/components/AgentOverrideDialog.tsx`** (new) —
  Dialog with read-only base summary + four editable fields (model
  select, extra prompt textarea, extra tools textarea, memory namespace
  input). `parseToolsList` is the exported pure helper. data-testids:
  `agent-override-dialog`, `agent-override-save`, `agent-override-reset`,
  `agent-override-extra-prompt`.
- **`apps/dashboard-web/src/components/OrgChartView.tsx`** gains an
  `onNodeClick` handler that opens the `AgentOverrideDialog` for the
  clicked role. The dialog is rendered as a sibling to the ReactFlow
  canvas with controlled `open` state.
- **i18n** EN + DE under `agentOverride.*` (title, description, fields.*,
  actions.*, toasts.*).

### Tests

- **`packages/memory-mcp/src/__tests__/scope.test.ts`** — 4 tests:
  scope='project' writes to a different DB than scope='run'; project-
  scoped read-back works across `closeAll` cycles; project DB persists
  across simulated run boundaries (run A writes, run B reads); resolveStore
  throws when projectId is missing.
- **`apps/dashboard-server/src/__tests__/agent-overrides.test.ts`** — 8
  tests: GET empty list, GET 404 unknown project, PUT creates new, PUT
  upserts existing (UNIQUE enforced), GET single 404 / 200, DELETE 204,
  PUT empty body rejected, PUT unknown project 404.
- **`apps/dashboard-server/src/__tests__/handoff-injection.test.ts`** — 4
  tests: two seeded handoffs render a markdown section in role order;
  empty list → empty string; malformed rows skipped without throwing;
  limit caps results.
- **`apps/dashboard-server/src/__tests__/mcp-config.test.ts`** — 2 new
  cases for the projectId branch: env carries `HARNESS_PROJECT_ID` +
  `WISP_DATA_DIR` when supplied, omits both when not.
- **`apps/dashboard-web/src/components/OrgChartView.test.tsx`** — 1 new
  case: clicking a node opens the `AgentOverrideDialog` and prefills the
  existing override fields from the fetched row.

### Fixed

- **`apps/dashboard-server/src/__tests__/org-chart.test.ts`** — the
  "most-recent plan" case used `randomUUID()` for two plan ids and relied
  on `orderBy(desc(plans.id))` returning them in insertion order. That
  works only when the second UUID happens to sort after the first; the
  test was silently flaky in v1.13. Pin both ids to lexicographically
  sortable strings (`plan-1-…` / `plan-2-…`) so the latest-plan path is
  exercised deterministically.

CI: 388 server / 116 web / 45 schemas / 33 memory-mcp / typecheck clean /
lint clean / prettier clean.

## 1.13.0 — Per-project team org-chart (Phase 5)

Closes the "who is on this project" gap that's been open since teams became
projects-of-agents in v1.9. Before this release the only way to see a
project's team was a flat badge list at the top of the Project Detail page.
After this release every project page has a **Team Chart** tab between
**Plan & Team** and **Runs** that visualises the team as a directed graph:
nodes are roles (architect / developer / qa / …), edges are hand-offs
derived from the most recent plan's DAG, and each node carries the agent's
avatar (or initials fallback), display name, model badge, and a live-status
pill (idle / working / done / failed) that refreshes every 5 seconds while
a run is active.

The design deliberately stays small. The role-edge derivation is one pass
over the plan's node-level edges, collapsed to (from-role, to-role) pairs
and deduplicated; self-loops at the role level are dropped because they
carry no chart signal. Live status is a single Drizzle query against the
latest run's tasks aggregated per-role under a fixed severity hierarchy
(`failed > running > done > idle`). The chart reuses the existing
`ReactFlow + dagre` toolchain that ships with `PlanCanvas`; no new npm
dependencies. Handoff edges (kind `'handoff'`) ship as a visual distinction
today (solid stroke vs the dashed plan-dep stroke) — Phase 6 will populate
them from the memory-mcp routing tree.

### Added

- **`apps/dashboard-server/src/routes/org-chart.ts`** — single endpoint
  `GET /api/projects/:projectId/org-chart`. Returns a `roles` array (one
  per team role, with displayName from the linked agent or fallback to
  the role name, plus model / avatarUrl / color / seedKey / agentId),
  an `edges` array of role-level pairs derived from the most-recent
  plan's DAG (`kind='plan-dep'`, deduped), a `liveStatus` array
  aggregated from the latest run's tasks, and the latestPlanId /
  latestRunId pointers so the UI can deep-link. 404 on unknown project;
  empty `roles` (not 404) when the project has no team yet so the UI
  renders a "no team yet" empty state without juggling 404 plumbing.
  Registered in `routes/index.ts` after the change-requests routes.
- **`apps/dashboard-web/src/components/OrgChartView.tsx`** — ReactFlow
  + dagre renderer (TB layout, nodesep 30, ranksep 50) with a custom
  `AgentNode` card (180×96 px): 32 px avatar with initials fallback, a
  display name (truncate), a font-mono role label, a model badge, an
  optional "seed" badge for agents with a seedKey, and a 2×2 status
  pill in the top-right corner (gray / blue-pulse / emerald / red for
  idle / working / done / failed). Plan-dep edges render with a dashed
  stroke; handoff edges (Phase 6) with a solid stroke; both use
  `hsl(var(--muted-foreground))`. data-testid hooks cover
  `org-chart-view`, `org-chart-empty`, `org-chart-node-{role}`, and
  `org-chart-status-{role}`. When the API returns an empty `roles`
  array the component renders an EmptyState card with a CTA link to
  the team editor.
- **Five-field `useOrgChart` hook** in `apps/dashboard-web/src/api/queries.ts`
  alongside the `OrgChartRole` / `OrgChartEdge` / `OrgChartLiveStatus` /
  `OrgChartResponse` types. Refetches every 5 s so the live-status pills
  update during an active run.
- **`ProjectDetail.tsx`** gains a **Team Chart** tab between **Plan &
  Team** and **Runs** with the `Network` lucide icon. The tab content
  is `<OrgChartView projectId={p.id} />`.
- **i18n** EN + DE under `orgChart.*` (title / description /
  status.{idle,working,done,failed} / legend.{planDep,handoff} /
  empty.{title,description,action}) and a new `projectTabs.org` entry
  ("Team Chart" / "Team-Chart").

### Tests

- **6 new in `org-chart.test.ts`** — 404 for unknown project, empty
  `roles` when no team is configured, role list + plan-derived edges
  deduped at role granularity (4 node-level edges collapse to 2
  role-level edges), live-status aggregation (one task `done` + one
  task `running` on the same role yields `working`), failed status
  wins when one task is `failed` even with another `done`, and
  latest-plan selection across multiple plans.
- **2 new in `OrgChartView.test.tsx`** — empty state when the API
  returns `roles: []`, and node rendering with status-pill class
  mapping for `done` (emerald) and `working` (blue + animate-pulse).
  Uses a `vi.mock('reactflow', …)` stub so the custom node renders
  without needing ReactFlow's real width/height measurements in jsdom.

CI: 374 server / 115 web / 45 schemas / typecheck clean / lint clean /
format clean.

## 1.12.0 — Visual edit + change-request queue (Phase 4)

Closes the eyeball-to-iteration loop the Preview tab opened in v1.11. Before
this release the only way to act on something you noticed in the preview was
to switch back to the chat tab and describe the problem from scratch. After
this release you toggle **Edit Mode** inside the Preview tab, click the
element you want to change, type a sentence, and the request lands in a
project-scoped queue. One **Run Iteration** click kicks off a planner-led
iteration run that consumes every pending request and navigates straight to
the new run's view — no detour through the plan editor or the manager chat.

The design deliberately stays small. The inspector that highlights elements
inside the iframe is a ~140-line vanilla-JS string inlined into the bundle
and injected at iframe-load time (same-origin via the v1.11 reverse-proxy);
no extra static asset, no MutationObserver, no React-in-an-iframe. The Run
Iteration chain is three plain `await` calls in a single mutation — plan,
lock, start — with step-numbered error messages instead of react-query's
mutation-chain helpers. Screenshot upload is intentionally out of scope; a
selector plus a bounding rect is enough for the planner to act on.

### Added

- **`apps/dashboard-server/src/routes/change-requests.ts`** — full CRUD
  for the `change_requests` table that's existed since v1.9 Phase 0.
  `GET /api/projects/:projectId/change-requests?status=...` defaults to
  `pending` and orders rows oldest-first so the queue UI reads naturally.
  `POST` validates source / selector / rectJson / userPrompt via zod and
  inserts a `pending` row; `PATCH` updates status or userPrompt; `DELETE`
  is a hard delete and returns 204. All four endpoints 404 on a
  cross-project id mismatch so a row in project A is invisible from
  project B's endpoints. Registered in `routes/index.ts` after the
  preview routes.
- **`apps/dashboard-web/src/components/preview-inspector.ts`** — exports
  `INSPECTOR_SCRIPT` (the raw JS body) and `INSPECTOR_VERSION = '1'`. The
  body is idempotent (early-exits on a re-injection via a window-scoped
  flag), draws a 2px outline + a font-mono selector label on mouseover,
  builds stable CSS selectors as `#id` or `tag.class:nth-of-type(N)` up
  to 5 segments deep, and posts `wisp:pick` payloads to
  `window.parent` on click (with `preventDefault` + `stopPropagation` so
  the click doesn't navigate the page inside the iframe). Listens for
  `wisp:set-edit-mode` from the parent so the inspector can be
  toggled without re-injection.
- **`PreviewFrame.tsx`** gains an **Edit toggle** (lucide `Edit3`,
  disabled when the preview isn't running) and a **side panel** that
  renders when edit-mode is on and an element has been picked. The panel
  shows the captured selector, the rect dimensions, and a textarea
  bound to `useCreateChangeRequest`. The iframe's `onLoad` injects the
  inspector script via `iframe.contentDocument.body.appendChild` (the
  reverse-proxy makes the preview same-origin so this just works); a
  parent-window `message` listener funnels picks into local state.
  `PendingChangesPanel` is rendered below the iframe regardless of
  preview state so users can curate the queue with the dev-server
  stopped.
- **`apps/dashboard-web/src/components/PendingChangesPanel.tsx`** —
  the queue card. Renders pending rows with source icon (visual /
  text), userPrompt, selector, and a per-row Delete button. Includes
  a small free-form text-mode form at the top for `source='text'`
  entries that don't need a selector. The **Run Iteration** button is
  disabled when the queue is empty; clicking it fires the chained
  `useRunIteration` mutation and navigates to
  `/projects/:projectId/run/:runId`. data-testid hooks cover
  `pending-row-{id}`, `pending-delete-{id}`, `run-iteration-button`,
  `text-mode-textarea`, `text-mode-submit`.
- **Five new hooks** at the change-request section of
  `apps/dashboard-web/src/api/queries.ts`:
  - `useChangeRequests(projectId, status?)` — 5s refetch interval.
  - `useCreateChangeRequest(projectId)` — POST.
  - `usePatchChangeRequest(projectId)` — PATCH (status and/or
    userPrompt).
  - `useDeleteChangeRequest(projectId)` — DELETE.
  - `useRunIteration(projectId)` — three-step chain (POST /plan →
    POST /lock → POST /runs) with step-tagged error messages
    (`"Step 1/3 failed: ..."`) so the toast on the Pending panel can
    point at the failure.
- **i18n** EN + DE under `preview.edit.*`, `preview.changes.*`, and
  `preview.toasts.*` (added/addFailed/deleted/deleteFailed/
  iterationStarted/iterationFailed).

### Tests

- **8 new in `change-requests.test.ts`** — GET empty, POST text source,
  POST visual source with selector + rectJson roundtrip, POST rejects
  empty userPrompt (400), PATCH pending → dismissed (and confirms the
  default GET no longer surfaces it while `?status=dismissed` does),
  DELETE returns 204 and removes the row, cross-project isolation
  (project A's row is invisible from project B), and 404s on unknown
  project id for GET + POST.
- **5 new in `PendingChangesPanel.test.tsx`** — list renders rows from
  the fetch mock, delete button removes the row, Run Iteration fires
  POST /plan + POST /lock + POST /runs in sequence and navigates via
  `MemoryRouter` to the new run view (verified by a `LocationProbe`
  component), button is disabled with an empty queue, text-mode form
  POSTs a `source='text'` change-request.
- Existing `PreviewFrame.test.tsx` updated to wrap in `MemoryRouter`
  (PendingChangesPanel uses `useNavigate`) and to stub the
  `/change-requests` fetch.

CI: 368 server / 113 web / 45 schemas / typecheck clean / lint clean /
format clean.

## 1.11.0 — Preview tab (Phase 3)

Closes the visual-feedback gap between iterations. Before this release the
only way to eyeball the project the harness was building was to open a
second terminal, `pnpm dev` into the worktree, and remember the right port.
After this release every project page has a Preview tab that boots the
project's dev server inside the harness and frames it via a loopback
reverse-proxy at `/preview/:projectId/`. The tab also doubles as the
landing tab once the brief is finalised and the first run has produced a
project state — the planner-to-eyes loop is now one click.

Two deliberate cuts to keep the surface small: (1) **no console-log
streaming** — the preview is a hosted iframe, not an embedded devtools
panel; users who need logs read the spawned process's terminal. (2) **no
`@fastify/http-proxy` dependency** — a ~50-line manual streaming forwarder
on top of node's built-in `http` module is plenty for a single-upstream,
loopback-only proxy and avoids dragging in a transitive plugin tree.

### Added

- **`orchestrator/preview-server.ts`** — `PreviewProcessRegistry` owns the
  per-project dev-server lifecycle. `startPreview` is idempotent (a second
  call for the same project returns the live entry instead of spawning a
  duplicate), polls the probe URL until a non-5xx response or a 60s
  timeout, and surfaces a `{ status, port, pid, startedAt, error? }`
  payload. `stopPreview` is safe to call when nothing is running. The
  Windows tree-kill path uses `taskkill /T /F` to bring down the
  downstream vite/node worker — same trick as `boot-smoke.ts`.
- **`src/routes/preview.ts`** — three control endpoints
  (`POST /api/projects/:id/preview/start|stop`, `GET .../status`) plus the
  catch-all `ALL /preview/:projectId/*` reverse-proxy. Manual streaming
  forwarder strips `accept-encoding` from the upstream request, rewrites
  the host header to the loopback target, and pipes the response straight
  through. 502 with `preview_not_running` when no entry is registered.
  Falls back to `detectProjectType` for projects without an explicit
  `runtimeVerifyDevCmd` / `runtimeVerifyProbeUrl`; returns 400
  `no_dev_cmd` only when both the project setting AND the detector come
  up empty.
- **`PreviewFrame` component** in `dashboard-web/src/components`. Status
  pill (stopped / starting / running / error), Start + Stop buttons with
  proper disabled gating, viewport switcher
  (Desktop / Tablet 768px / Mobile 375px) applied via inline style on the
  iframe, and the iframe itself with
  `sandbox="allow-scripts allow-forms allow-same-origin"`. The iframe is
  keyed by `port` so a port change forces a clean reload. data-testid
  hooks cover every interactive element.
- **`useStartPreview` / `useStopPreview` / `usePreviewStatus` hooks** at
  the bottom of `dashboard-web/src/api/queries.ts`. Status auto-refetches
  every 2s when the preview is running, 5s otherwise.
- **Tabs on the Project Detail page** — `Brief`, `Plan & Team`, `Runs`,
  `Preview`, `Settings`. The 3-card summary header
  (Goal / RepoPath / Team) still sits above the tabs as the page header.
  Initial tab is `Preview` when the brief is finalised AND a project
  state exists; otherwise `Brief`. The initial value is frozen at first
  render so later interview/state refetches don't yank the user off
  whatever tab they're looking at.
- **i18n** EN + DE under `projectTabs.*` (brief/plan/runs/preview/settings)
  and `preview.*` (title/description/start/stop/empty/viewport.\*/
  status.\*/toasts.\*).

### Tests

- 4 new in `preview-server.test.ts` — `startPreview` happy path with a
  stubbed spawn+fetch, `stopPreview` idempotency, reverse-proxy happy path
  against a real in-process upstream HTTP server, and 502
  `preview_not_running` for an unregistered project. The reverse-proxy
  test uses the registry's `__test_register` seam so it doesn't need to
  spawn `pnpm dev`.
- 2 new in `PreviewFrame.test.tsx` — initial stopped state (Start enabled,
  Stop disabled, empty placeholder visible) and Start flow asserts both
  that the POST fires and that the iframe with the right `src` /
  `sandbox` shows up once the status flips.

CI: 360 server / 108 web / 45 schemas / typecheck clean / lint clean /
format clean.

## 1.10.0 — Project state + iteration planner (Phase 2)

Closes the "every run is greenfield" gap. Before this release run N+1 had no
formal signal that the project already existed — the planner re-built from
scratch each time. After this release the runtime-verifier writes
`docs/project-state.md` after every successful run, the harness persists
a `project_states` row, and the next plan is auto-tagged `kind='iteration'`
with the prior state + any pending change-requests injected into the
planner's context. The planner is now told explicitly: "this is an
ITERATION plan — plan a SURGICAL delta. Do not re-implement what is
already shipped."

### Added

- **`runtime-verifier` writes `docs/project-state.md`** as step 9 of its
  workflow with four canonical sections (Implemented features / Open todos
  / Known issues / Architecture snapshot JSON). The harness parses the
  sections back into structured JSON for the next iteration plan.
- **`orchestrator/project-state-loader.ts`** — tolerant markdown parser
  (handles missing fences, malformed JSON, mixed bullet markers, extra
  prose between sections), git-show loader, persistence helper, and a
  `getLatestProjectState` retrieval. 13 unit tests.
- **`handlePostRunSuccess` hook** persists a `project_states` row after
  every successful run that produced a docs/project-state.md.
- **Plan-kind detection** in `POST /api/projects/:id/plan`:
  - Prior `project_states` row present → `kind='iteration'`
  - Otherwise → `kind='initial'` (existing behaviour)
  - Hardening chain already produces `kind='hardening'` via self-healing.
- **Iteration context injection** — when `kind='iteration'`, the planner
  receives:
  - `## Current project state (from prior run)` with Implemented features,
    Open todos, Known issues (matching the verifier's structure)
  - `## User change-requests to address THIS iteration` with each pending
    change_request rendered as a CR-N block (id + source + selector +
    user prompt). Honours an optional `changeRequestIds[]` body filter.
- **`POST /api/runs` accepts `changeRequestIds[]`** — eligible rows
  (same project + status='pending') get flipped to `'in-run'` and linked
  to the new runId. Foreign-project or already-done ids are silently
  ignored so a client cannot mutate other queues.
- **`GET /api/projects/:id/state`** returns the latest project_states row
  (null when the project has never been verified).
- **`ProjectStateCard`** under the BriefCard on every project page —
  three columns (Implemented features / Open todos / Known issues) with
  counts, empty-state copy, and a "+N more" overflow at 8 items.
  Hidden when no state exists.
- **`useProjectState` hook** + `ProjectStateRow` type in
  `dashboard-web/src/api/queries.ts`. Auto-refetch every 30s.
- **i18n** EN + DE under `projectState.*` plus `projectState.planKind.*`
  labels.

### Tests

- 13 new in `project-state-loader.test.ts` (parser + persist + retrieve).
- 4 new in `iteration-plan.test.ts` (initial vs iteration detection,
  change-request injection in pendingChangeRequestIds, explicit ids
  filter).
- 1 new in `runs.test.ts` (POST /api/runs links eligible CRs only,
  skips foreign-project + already-done).
- Existing plans.test.ts happy-path now asserts `kind='initial'` /
  `parentStateId=null` on first plan.

CI: 356 server / 117 web / 45 schemas / typecheck clean / lint clean /
format clean.

## 1.9.0 — Requirements-interviewer agent + brief gate (Phase 0+1)

First slice of the v1.9 production-loop pipeline: agent-driven elicitation
before any planning runs. Before this release the planner received a
single `goal` string and guessed everything else (audience, success
criteria, design prefs, platform, constraints, deadline). After this
release Sarah — a new seed agent — interviews the user one structured
question at a time and writes `docs/PRD.md`. The planner refuses to
generate a plan until the brief is finalised (override via
`X-Allow-Unbriefed: 1` for scripted use).

### Added (Phase 1b — Brief UI)

- **`BriefCard`** at the top of every project page. Shows a completeness
  Progress bar, a structured summary of the captured fields, the
  transcript with Sarah, and a message composer. Switches to a
  collapsed-summary mode once `briefReady=true` with an expand toggle
  to revisit the conversation.
- **TanStack hooks** in `apps/dashboard-web/src/api/queries.ts`:
  `useInterview`, `useStartInterview`, `useSendInterviewMessage`,
  `useFinalizeInterview`, `usePatchBrief` plus full Row types.
- **i18n** under `briefCard.*` for EN + DE.
- **5 component tests** for the BriefCard (pending state, message
  round-trip advancing the score, finalize disabled-at-zero gate,
  finalize collapses chat, expand-when-ready reveals transcript).

### Added (Phase 1a — interview agent backend)

- **`requirements-interviewer` seed agent** (Sarah, Opus). Asks structured
  one-question-at-a-time turns for target audience, success criteria,
  design preferences, platform, constraints, deadline. Emits a
  `<<BRIEF_PATCH>>{...}<<END>>` JSON block every turn and an optional
  `<<BRIEF_COMPLETE>>` marker when she has ≥80% coverage.
- **`briefPatchSchema` + `parseBriefPatchFromText`** in
  `@wisp/schemas` — strict Zod validation of agent patches, plus
  a tolerant text extractor that strips machine markers before the user
  sees the assistant message.
- **`interviewer-engine.ts`** — pure async runner over the existing
  `runAgentTurn` primitive: takes a brief snapshot + transcript + user
  reply, returns `{ assistantText, patch, nextBrief, shouldFinalize }`.
  Monotone-non-decreasing `completenessScore` so a regression turn cannot
  lower the gate. `renderBriefAsPrdMarkdown` produces `docs/PRD.md`.
- **Interview REST routes** at `/api/projects/:projectId/interview*`:
  - `GET` — brief + transcript
  - `POST /start` — idempotent ensure brief + thread
  - `POST /message` — append user message, run one interviewer turn,
    persist assistant reply, return new brief state
  - `POST /finalize` — write `docs/PRD.md` to the managed repo, flip
    `briefReady=true`
  - `PATCH` — direct manual field edits (escape hatch for power users)
- **Auto-seeded brief on every project creation** — both the dashboard
  sidebar `POST /api/projects` and the manager-chat
  `<<ACTION>>create_project<<END>>` directive now call `ensureBriefRow`,
  so both surfaces converge on identical post-create state.
- **Planner gate** on `POST /api/projects/:id/plan` — returns `412
  Precondition Failed` with `error: brief_not_ready` when the project
  brief is not finalised. Power-users can bypass via `X-Allow-Unbriefed:
  1` header. The brief is also injected into the planner's
  `additionalContext` (sections: target audience, success criteria,
  design preferences, platform, constraints, deadline).
- **22 new tests** (11 schema + 11 routes/engine) verifying brief patch
  parsing, monotone completeness, BRIEF_COMPLETE handling, idempotent
  start, message accumulation, finalize write semantics, planner gate
  412/override behaviour, and dual-path auto-seed.

### Added (Phase 0 — schema foundation)

- **`project_briefs` table** (migration 0012) — holds the
  requirements-interviewer agent's structured output (target audience,
  success criteria, design prefs, platform, constraints, deadline) plus a
  `completenessScore` and `briefReady` gate. One brief per project (UNIQUE
  index). Planner will require `briefReady=true` before Phase 1 ships.
- **`change_requests` table** (migration 0013) — queue of pending
  "change this region" / "add this feature" notes captured from the
  Preview tab. Supports both visual-mode (selector + rect + screenshot)
  and text-mode (plain prompt). Status flow: pending → in-run → done /
  dismissed. Iteration runs consume the pending set.
- **`project_states` table** (migration 0014) — post-run snapshot of
  what the project actually does today: completed features, open todos,
  known issues, thin architecture snapshot. Iteration planners will
  consume the most recent row for surgical (non-greenfield) plans.
- **`project_agent_overrides` table** (migration 0015) — per-project
  per-role customisation: extra system-prompt tail, model swap, extra
  allowed-tools, dedicated memory-namespace. Additive over the shared
  `/agents/*.md` definitions. UNIQUE on `(project_id, role)`.
- **`plans.kind` + `plans.parent_state_id`** (migration 0016) — Plans
  now carry their generation context: `initial` (greenfield), `iteration`
  (consumes a `project_states` row + pending change-requests), or
  `hardening` (auto-spawned by self-healing). `parent_state_id` links
  iteration plans to the state snapshot they were built against.
- **`projects.package_target` + `projects.artifact_path`** (migration
  0017) — Optional native-packaging target. `'web'` (default) keeps the
  current behaviour. `'tauri-exe'` / `'electron-exe'` / `'pkg-bin'`
  enable the v1.9 packager agent that produces a downloadable installer
  after the release-gate goes ready.
- Schema types in `@wisp/schemas`: `ProjectBrief`,
  `ChangeRequest`, `ProjectState`, `ProjectAgentOverride`, `PlanKind`,
  `PackageTarget` plus their `New*` insert types and the matching enum
  value arrays (`planKindValues`, `packageTargetValues`,
  `changeRequestStatusValues`, `changeRequestSourceValues`).
- Migration test coverage: 7 new assertions in `migrations.test.ts`
  verifying the schema lands cleanly, defaults are correct, the UNIQUE
  constraints fire, and project deletion cascades to `change_requests`.

## 1.8.0 — Runtime verification + Definition-of-Done release-gate

Closes the largest gap between "the harness says it's done" and "the app
actually works". Static checks (build, typecheck, unit tests) prove a
codebase compiles; v1.8 adds a third layer that proves it _runs_ in a
real browser, and a fourth that proves it satisfies the acceptance
criteria the user declared.

### Added

- **Runtime-verifier agent role.** A new agent role
  (`runtime-verifier`) gets auto-injected behind every terminal node
  on every plan that the planner produces. Its job: start the dev
  server, probe the URL, run @playwright/test specs against the
  user's Definition-of-Done criteria, capture screenshots, and emit
  BOTH `docs/runtime-report.md` (human-readable, scanned by the
  findings parser for HIGH/CRITICAL rows) and
  `docs/runtime-report.json` (machine-readable, source of truth for
  the release-gate).
- **Definition of Done (DoD) per project.** New `dod_criteria` table
  and full CRUD at `/api/projects/:id/dod` (GET/POST/PATCH/DELETE/
  PUT-bulk-replace). Three kinds: `smoke` (HTTP probe), `e2e`
  (Playwright user action), `manual` (human sign-off, never
  auto-pass). Authored from the new Definition-of-Done card on the
  project detail page.
- **Release-gate.** `evaluateReleaseGate()` is a pure decision
  function over run outcome + runtime-report verdict + actionable
  findings count + DoD progress. Three verdicts:
  - `READY` — auto-merge proceeds.
  - `BLOCKED` — auto-merge held; self-healing chain (if enabled)
    picks up failing gates and tries again.
  - `MANUAL-REVIEW` — auto gates passed, manual criteria still need
    a human signature.
- **Auto-injection of the verifier into planner output.**
  `injectRuntimeVerifier()` post-processes a planner-emitted Plan,
  appending the role + node + edges from every DAG terminal.
  Idempotent, refuses on the 8-role team cap, returns the unchanged
  plan when injection isn't applicable.
- **Playwright cache management.** `ensurePlaywrightCached()` installs
  Chromium once into `~/.cache/wisp/playwright-browsers`
  pointed to by `PLAYWRIGHT_BROWSERS_PATH`. Every worktree shares
  the cache so the first download pays the cost and subsequent runs
  are instant.
- **`pnpm doctor` command.** Sanity check for v1.8 prerequisites
  (Node, pnpm, claude, git, playwright cache, npx). Diagnostic only;
  exits 0. Prints the exact one-liner to fix any missing piece.
- **Dashboard.**
  - `DefinitionOfDoneCard` on ProjectDetail — kind-aware add/delete
    rows, icons per kind, one-line spec summary inline.
  - `ReleaseGateCard` on RunView — verdict pill with colour-coded
    tone, Boot / E2E / DoD count badges, collapsible `<details>`
    rendering the agent's `docs/runtime-report.md` verbatim.
  - Project patch route accepts `runtimeVerifyEnabled`,
    `runtimeVerifyDevCmd`, `runtimeVerifyProbeUrl` so the user can
    override the auto-detected dev command / probe URL.
- **Project-type detection.** `detectProjectType()` classifies a repo
  from package.json (web-app, backend, cli, library, unknown) and
  recommends a dev command + probe URL. Conservative — returns
  `unknown` rather than guessing.
- **Boot-smoke runner.** `runBootSmoke()` spawns the dev command,
  polls the probe URL until a non-5xx response or timeout, kills the
  process tree cleanly on Windows + POSIX.
- **`runtime_reports` table.** One row per (run, verifier iteration),
  persists the structured verdict so the dashboard renders it
  without re-fetching the result branch.

### Changed

- **Post-success hook** in `RunRuntime` now parses the plan →
  determines whether the runtime-verifier was expected → reads
  `docs/runtime-report.json` → scans findings → counts DoD criteria
  → calls `evaluateReleaseGate()` → persists a `runtime_reports` row
  → gates auto-merge on the verdict. Legacy plans without the
  verifier degrade gracefully to the v1.7 behaviour.
- **Findings scanner** now reads `docs/runtime-report.md` alongside
  `security-review.md` and `qa-report.md`, so a failing E2E flows
  into the self-healing chain identically to a security finding.

### Migration

- Migration 0011 adds `dod_criteria` + `runtime_reports` tables, plus
  three `projects.runtime_verify_*` columns (default ON for all
  rows). Existing projects pick up the feature without a manual flip;
  the release-gate falls back to legacy behaviour for plans that
  don't yet include the verifier (the v1.8 planner auto-injects it
  for new plans only — old locked plans still run unchanged).

## 1.7.16 — Autopilot: pause-reason gating + resumeAt respect + decision log + watching banner

Closes three behavioural gaps in the autopilot tick that surfaced once
v1.7.15 made the feature actually reachable from project-level UI:

### Fixed

- **Pause-reason filter.** The cron handler `tickAutopilot` previously
  picked up every `paused + autopilotMode=true` row and tried to resume
  it. That meant a user-clicked Pause would silently bounce back on the
  next tick, and a `consecutive-failures` pause (structural — the
  walker just hit the threshold) would keep re-running into the same
  wall. The tick now filters to `pausedReason ∈ {rate-limit, shutdown}`
  only. User-pause + consecutive-failures require a manual Resume click.
- **`resumeAt` respect for rate-limit.** Rate-limit pauses come with a
  `resumeAt` timestamp from the rate-limit handler. The tick previously
  ignored it and would hammer the API until the resume itself
  re-tripped the limit. Now it waits silently until `resumeAt` is in
  the past before claiming the run.

### Added

- **Decision audit log.** Every actionable decision the tick takes
  (resumed, halted on budget, resume-failed, resume-errored) is now
  persisted as an `autopilot.decision` row in the events table, scoped
  to the run. Lets the user see what autopilot actually did instead of
  guessing from the eventual outcome. Pure skips
  (pause-reason-not-auto-resumable, rate-limit-window-still-open) are
  intentionally NOT logged — they would spam the feed every minute.
- **"Autopilot wacht" indicator** on the RunView. When a run is paused
  with an auto-resumable reason AND autopilot is on, a small green
  emerald banner shows under the AutopilotToggle: "Autopilot wacht —
  wartet bis HH:MM:SS" with the resumeAt time, or "bereit zum
  Auto-Resume" for shutdown pauses.
- **AutopilotToggle tooltip.** A new `Info`-icon next to the label
  shows on hover a one-liner explaining exactly what autopilot does:
  what it auto-resumes, what it explicitly leaves alone, and where it
  stops. Eliminates the common "autopilot = run the whole goal
  autonomously" mental-model mismatch.

### Tests

5 new tick cases in `autopilot.test.ts`:
- user-paused run → skipped, not resumed
- consecutive-failures-paused run → skipped, not resumed
- rate-limit run with `resumeAt` in the future → skipped (window open)
- shutdown run with budget already blown → halted + decision event
  with `action='halted'` persisted to the events table
- autopilotMode=false run → ignored (not even in the candidate set)

## 1.7.15 — Project-level autopilot defaults + chain visualisation + harden-run endpoint

Closes the UX gap exposed by the v1.7.14 wertzeit-app dry run: a 4-deep
self-healing chain worked end-to-end on the harness side but was invisible
in the project Run-Historie, and autopilot still had to be re-toggled
per run. Three follow-up changes:

### Added

- **Project-level autopilot defaults.** Three new project columns
  (`default_autopilot_mode`, `default_autopilot_budget_minutes`,
  `default_autopilot_budget_tokens`) act as the seed value for every new
  run started against the project. The per-run `AutopilotToggle` still
  overrides for the active run; the project defaults are just the
  starting point so users don't have to re-toggle autopilot on every
  new run for the same project.
- **Run-Historie chain indicator.** The project's run list now shows a
  `↳ Iter N` badge next to each follow-up run, with `Parent: <8-hex>`
  as the title attribute so the relationship is hover-discoverable.
  Powered by `parent_run_id` + `chain_iteration` now included in the
  `GET /api/projects/:id/runs` projection.
- **`POST /api/projects/:id/harden-run` endpoint.** Manual one-shot
  trigger for a self-healing iteration on a project, given any prior
  successful run on it. Same machinery as the post-success hook —
  scans the parent run's result branch for findings, builds the
  hardening plan, inserts it, starts a new run with
  `chain_iteration=parent+1`. Used to retroactively chain runs that
  completed before v1.7.14 existed; also useful if a user wants to
  force a re-pass without re-running the original goal.

### Schema

Migration `0010_project_run_defaults.sql`:
- `projects.default_autopilot_mode` integer NOT NULL DEFAULT 0
- `projects.default_autopilot_budget_minutes` integer NULL
- `projects.default_autopilot_budget_tokens` integer NULL

### UI

The Production-Modus card on the project page gains a "Run-Defaults"
sub-block with the autopilot toggle and the two budget inputs. The
existing per-run AutopilotToggle on the RunView keeps working
unchanged.

### Tests

`project-autopilot-defaults.test.ts` covers (a) project default true →
new run row carries autopilotMode=true + budgets + autopilotStartedAt,
(b) project default false → new run keeps autopilot off, (c) explicit
parentRunId + chainIteration overrides still take effect.

## 1.7.14 — Production loop: auto-merge + self-healing chain

Two harness-level features that close the "finish my app in one goal" gap
exposed by the wertzeit-app run on v1.7.13: the result branch sat 24
commits ahead of main with a clean PASS verdict but 9 security findings
that no one ever picked up. v1.7.14 turns these into automated steps.

### Added

- **`projects.auto_merge_on_success`** (default `true`). After every
  successful run the runtime's post-run hook fast-forwards
  `wisp/<runId>/result` into `main`. Strategy: prefer `git update-ref`
  (no working-tree touch, atomic compare-and-swap from old main SHA) for
  the FF case; fall back to a detached worktree at the current main
  commit + `git merge --no-ff` when main has diverged. Conflicts leave
  main untouched and surface a `[harness] auto-merge … FAILED` text
  delta on the run feed.
- **`projects.self_healing_enabled`** (default `false`) +
  **`projects.max_chain_iterations`** (default `3`). When enabled, the
  same post-run hook reads `docs/security-review.md` and
  `docs/qa-report.md` from the result branch, extracts every
  CRITICAL/HIGH/MEDIUM finding (regex-based parser; handles both
  Markdown table rows and `### Finding N — HIGH:` headers), and if any
  remain spawns a follow-up "hardening run" with a hand-crafted 2-node
  DAG (`security` fixes → `qa-engineer` verifies). The chain stops when
  either no actionable findings remain OR `chain_iteration >=
  maxChainIterations`. Runs in a chain are linked by
  `runs.parent_run_id` + `runs.chain_iteration`.
- **Dashboard "Production-Modus" card** on the project detail page with
  the three toggles and a Speichern/Gespeichert indicator wired to the
  existing `PATCH /api/projects/:id` route.
- **Chain-iteration badge** on RunView linking back to the parent run.

### Schema

Migration `0009_production_loop.sql`:
- `projects.auto_merge_on_success` integer NOT NULL DEFAULT 1
- `projects.self_healing_enabled` integer NOT NULL DEFAULT 0
- `projects.max_chain_iterations` integer NOT NULL DEFAULT 3
- `runs.parent_run_id` text NULL
- `runs.chain_iteration` integer NOT NULL DEFAULT 0

### Tests

- `findings.test.ts` (10 assertions): table-row + header parsing,
  dedupe of summary/detail twins, severity gating.
- `auto-merge.test.ts` (5 cases against a real temp git repo):
  fast-forward, noop, divergent merge-commit, conflict-leaves-main-alone,
  missing-result-branch.
- `self-healing.test.ts` (9 assertions): chain-decision pure logic,
  hardening-plan shape including planSchema round-trip, embedded
  parent-goal + findings text.

## 1.7.13 — Shutdown-aware pause banner + dirty-protected autopilot resync

### Fixed

- **Pause banner couldn't distinguish shutdown from user-pause.** Live on
  2026-05-15: after the v1.7.12 server restart for deployment, the
  wertzeit-app run sat at `status='paused', pausedReason='shutdown'` (the
  abrupt-crash recovery path). The `RunPausedBanner` in `RunView.tsx` only
  had two branches — `rate-limit` and "everything else → pausedByUser" — so
  the dashboard claimed "Run vom Benutzer pausiert." for a server-shutdown
  pause. New `pausedByShutdown` i18n string and a dedicated banner variant
  with `data-testid="shutdown-paused-banner"` and a `Fortsetzen` button.

- **Autopilot form clobbered unsaved edits.** `AutopilotToggle`'s resync
  `useEffect` ran on every change to the run-snapshot props
  (`initialEnabled`, `initialBudgetMinutes`, `initialBudgetTokens`) and
  unconditionally overwrote local form state. A 5-second background
  refetch or any WS-driven invalidation that landed mid-edit would
  silently un-tick the checkbox the user had just enabled or wipe a
  half-typed budget value — making it impossible to actually save
  autopilot on. The resync is now gated by refs that track `dirty` and
  `toggle.isPending`; the server snapshot is only adopted when the user
  has no unsaved edits and no save is in flight.

### Tests

- New `apps/dashboard-web/src/components/AutopilotToggle.test.tsx`:
  - No-clobber while dirty: user ticks checkbox, simulated stale refetch
    arrives with `enabled=false`, checkbox stays checked and Save still
    shows `data-dirty=true`.
  - Clean snapshot adoption: with no local edits, a server-side flip to
    `enabled=true` propagates into the form and `data-dirty=false`.
  - Save POST shape: enabled + budgetMinutes go up correctly and the form
    settles to `data-dirty=false` afterwards.
- `RunView.test.tsx` gains a `shutdown-paused-banner` rendering
  assertion when `pausedReason='shutdown'` (and confirms the legacy
  `user-paused-banner` does NOT render in that case).

## 1.7.12 — Inactivity watchdog on task subprocesses

### Fixed

- **Hung subprocess froze the run for hours.** Live failure on the 2026-05-15
  wertzeit-app retry on v1.7.11: n1-architecture's claude CLI emitted its
  final text-delta "Documentation complete" then never wrote its `result`
  frame and never exited. The harness had no per-task inactivity timeout —
  the walker held the slot indefinitely. The user had to manually pause the
  run after 3 hours.

  Walker now arms an inactivity watchdog (`deps.setTimeout`) that re-arms on
  every subprocess event and fires after `INACTIVITY_TIMEOUT_MS = 10min` of
  silence. On firing it emits a visible `[harness] subprocess inactive for
  10min — aborting and retrying as transient` text-delta to the dashboard,
  aborts the subprocess via the existing `AbortController.signal` plumbing,
  and routes the failure through the transient-retry path so the run picks
  up on the next attempt without consuming the structural retry budget.

  The 10-min default was picked from the healthy-run baseline (every
  observed n*-task gap between events was under 1 minute, even during
  long-thinking phases). Configurable later if needed.

### Tests

- New walker test: gated FakePool task hangs after emitting one event, fake
  timers advance past the inactivity timeout, abort propagates, retry on
  attempt 2 completes successfully. Verifies both the abort path AND the
  `[harness] inactive for ...` text-delta.

## 1.7.11 — Transient retries for main task subprocess + worktree-race retry

### Fixed

- **Main task subprocess hit Anthropic 529 on attempt 1 + attempt 2 and was
  declared dead.** Live failure on a 2026-05-15 wertzeit-app re-run: the
  529-overload storm from earlier in the day was still active, n3-skeleton's
  initial subprocess died at minute ~4 with `API Error: 529 Overloaded`, the
  walker burned its single structural retry on a second attempt that hit the
  same 529, then marked the task permanently failed. n6 + all downstream
  tasks then cancel-cascaded. The resolver path got its transient retry in
  v1.7.10, but the main task subprocess path didn't — and the same upstream
  blip kills that path too.

  Added a *separate* transient-retry budget (`MAX_TRANSIENT_RETRIES = 5`,
  10s × attempt backoff) on top of the existing `retries < 1` structural
  budget. The same shared `TRANSIENT_RE` constant detects 5(29|03) /
  Overloaded / Service Unavailable / temporarily unavailable / rate-limit /
  ETIMEDOUT / ECONNRESET in `task.text-delta` and `task.failed` payloads from
  the subprocess event stream. Transient retries don't consume the structural
  budget, so a real bug in the agent's work still surfaces after one normal
  retry. The new shared constant replaces the local copy inside the resolver
  path.

- **`git worktree add` race on Windows.** When two parallel tasks both
  depended on the same parent (e.g. n2 + n3 both `deps: [n1]`) and dispatched
  simultaneously, git hit a metadata-read race against the sibling's
  `.git/worktrees/<sibling>/commondir` and failed with `failed to read
  ...commondir: No error`. The walker had no retry for this and the task
  cascade-failed. Added a transient-retry loop inside `addWorktree` itself
  (3 attempts, 500ms × attempt backoff) that prunes stale worktree metadata
  before each retry and detects this and a few related Windows FS-race
  patterns (`sharing violation`, `Access is denied`, `cannot create file`,
  `file in use`).

### Tests

- New walker tests: subprocess succeeds after 2 transient 529s on the 3rd
  attempt; non-transient `boom` failure still consumes only the structural
  retry budget (no transient-retry burn for real bugs).

## 1.7.10 — Resolver retries through transient Anthropic 529 / Overloaded

### Fixed

- **Merge-resolver subprocess gave up on the first Anthropic 529.** Caught live
  on the 2026-05-15 wertzeit-app run: `n13-builder`'s resolver subprocess hit
  `API Error: 529 Overloaded` ~3 minutes in, the CLI exited 1 with 0 useful
  turns, and the walker tore down the attempt and failed `n13` —
  cascade-failing `n14-security-review` + `n15-qa-gate`. A momentary upstream
  blip was enough to kill three downstream tasks.

  The resolver loop now wraps its single subprocess call in a retry loop with
  exponential backoff (`5s`, `10s`) up to `MAX_RESOLVER_ATTEMPTS = 3`. The
  walker watches the subprocess event stream for transient-error markers:

  ```
  /\b5(29|03)\b|Overloaded|Service Unavailable|temporarily unavailable|rate.?limit|ETIMEDOUT|ECONNRESET/i
  ```

  matched against either `task.text-delta` text (where the claude CLI surfaces
  API 5xx errors) or `task.failed` error payloads. When `getMergeStatus`
  after the resolver still shows in-merge / unmerged paths **and** a transient
  marker was observed, the walker waits and respawns the resolver against the
  same mid-merge worktree. Files the previous attempt did manage to `git add`
  remain staged, so retries make progress rather than starting from zero.

  Non-transient failures (resolver finished without surfacing a 5xx marker
  but didn't commit the merge) skip the retry path entirely — those are
  structural and would just burn budget. Same for explicit
  `git merge --abort`s (rare but caught).

  Token / turn attribution to the parent task is preserved across retries.

### Tests

- New walker tests: resolver succeeds on retry after transient 529 →
  task completes; resolver exhausts all 3 attempts → task fails with
  `transient retries` in the reason; non-transient resolver failure →
  no retry, fail immediately (no budget waste).

## 1.7.9 — Auto-resolver for dep-merge conflicts

### Fixed

- **A dep-merge conflict between two parallel deps no longer kills the task.**
  Before: if `task X` had `deps: [a, b]` and both `a` and `b` had touched
  overlapping regions of the same file, `git merge --no-ff` conflicted and
  the walker marked `X` as `failed` with `dep-merge conflict: ...` — every
  downstream task then cascaded as `cancelled: upstream dep failed`. A real
  Wertzeit-app run lost `n12-pdf-export` (and via it `n13-builder`,
  `n14-security-review`, `n15-qa-gate`) to two parallel backend tasks
  both editing `src/renderer/pages/vertrag.{html,js}` on independent
  branches.

  The walker now retries the merge with `leaveOnConflict: true` (so the
  worktree stays mid-merge with `MERGE_HEAD` and unmerged paths) and spawns
  a focused **merge-resolver subprocess** (`Read/Edit/Write/Bash`, max 25
  turns) inside the worktree. The resolver inspects ours/theirs via
  `git show :2:<file>` / `git show :3:<file>`, integrates both intents,
  `git add`s every resolved file, and finalises with
  `git commit --no-edit`. Hard rules in the prompt forbid `git merge
  --abort` and forbid touching files that are not unmerged. After the
  subprocess exits, the walker re-checks `getMergeStatus`:

  - clean state + HEAD advanced → resolved, task continues normally.
  - still unmerged or MERGE_HEAD set → walker aborts the merge and falls
    back to the legacy `task.failed` path with `(auto-resolver: <reason>)`
    appended to the error so the failure is debuggable.
  - resolver aborted the merge or didn't change HEAD → same fallback.

  Resolver tokens / turns are attributed to the parent task so the
  dashboard's run-level counters include the cost of resolution.

### Added

- `mergeBranchesInWorktree(path, branches, { leaveOnConflict?: boolean })`
  — caller-controlled abort policy.
- `abortMergeInWorktree(path)` — idempotent merge abort helper.
- `getMergeStatusInWorktree(path)` — reads `MERGE_HEAD` + unmerged paths +
  HEAD commit, used by the walker to validate resolution.
- `WalkerDeps.abortMerge` / `WalkerDeps.getMergeStatus` (optional fields
  for backward-compat; legacy walker setups stay on the original
  fail-fast behaviour).

### Tests

- New walker tests cover three paths: resolver succeeds → task continues;
  resolver runs but doesn't finalise the merge → task fails with
  `auto-resolver` in the error string; legacy deps missing →
  unchanged behaviour.
- New worktree tests cover `leaveOnConflict: true` + `getMergeStatus`
  reporting the merge state correctly.

## 1.7.8 — Tasks reset to pending on every new run

### Fixed

- **Starting a fresh run still showed every task as `FEHLGESCHLAGEN`**
  (or whatever status the previous run left it in) until the walker actually
  reached that task and overwrote the row. The `tasks` table is keyed by
  `(planId, taskId)` and shared across every run of the same plan, and the
  seed-loop in `RunRuntime.startRun` used `insert ... onConflictDoNothing`,
  so previous-run state survived intact. Now we `UPDATE tasks SET status =
  'pending', worktreeBranch = NULL, sessionId = NULL, tokensIn = 0,
  tokensOut = 0, turnsUsed = 0, durationMs = 0 WHERE planId = ?` before the
  seed loop runs. The seed loop still uses `onConflictDoNothing` so new
  nodes added by a plan edit get inserted, while the bulk reset cleans every
  pre-existing row. Regression test in `runtime-task-reset.test.ts`.

## 1.7.7 — Subprocess Write-permission bypass + rate-limit false-positive killer

Diagnosed from a real Wertzeit-app run that died at `n1-architecture` with the
agents reporting "rate-limit reached" 6 seconds in, then failing verification
on subsequent retries because no files ever made it to disk. Two independent
bugs, both fixed.

### Fixed

- **Subprocess Write/Bash calls silently dropped because no UI to approve
  permission prompts.** `claude -p` was launched without `--permission-mode`,
  so the default mode requested approval for every Write — the model
  "wrote" `docs/architecture.md` four times, the tool-use events fired, the
  files never landed on disk, and the harness verifier (`accessSync(p)`)
  then failed twice with `ENOENT`, cascading the whole DAG to
  `cancelled: upstream dep failed`. Now passes
  `--permission-mode bypassPermissions`. The orchestrator runs subprocesses
  headlessly in an isolated per-task worktree, so this is the matching
  permission mode for a non-interactive sandbox.
- **Rate-limit detector false-positive on model prose.** The detector ran
  the `/rate.?limit/i` marker against the raw stdout chunk, which on
  `stream-json` output includes `assistant.message.content[].text` —
  whenever the agent narrated something like "I'll proceed carefully so we
  don't hit a rate limit boundary", the orchestrator paused the run for 6 s
  and marked the task as `rate-limited`. Now scans only stderr and
  structured stdout error frames (`result` with `subtype === 'error'` or
  `is_error === true`). Model prose can mention rate-limits all it wants —
  no pause.

### Tests

- New regression: `MOCK_MODE=prose-mentions-rate-limit` emits an assistant
  frame containing the literal text "rate limit" via stdout. Verifies no
  `rate-limit.hit` event fires and the task completes cleanly.
- New `buildArgs` assertion that `--permission-mode bypassPermissions` is
  always present, regardless of allowedTools / model / MCP config.

## 1.7.6 — TaskCard status-pill no longer clips in narrow columns

Polish after live-sweeping every route at 1056 px viewport with Chrome MCP.

### Fixed

- **TaskCard StatusPill clipped to `FEHLGESC`** inside narrow kanban columns
  (~120 px content width). The translated label "FEHLGESCHLAGEN" overflowed
  and rendered as garbage. Replaced the in-card status pill with a
  `StatusDotBadge iconOnly` — a colored, optionally-pulsing dot scoped to
  the card. The translated status name still appears in the kanban column
  header, so no information is hidden. The dot keeps an `aria-label` with
  the full status name for screen readers.
- The role-name label on the same row got `truncate` + `min-w-0` so a long
  role like `tech-writer` no longer pushes the dot off the row.
- Removed the now-unused `taskStatusTone` helper.

## 1.7.5 — RunView UX pass: sidebar scroll, vertical scroll, saved indicator, task-card metrics

User-driven hands-on pass on `/projects/:id/run/:runId` with the Chrome MCP.
Live-verified every fix in a real browser before claiming done.

### Fixed

- **Sidebar projects nav was unscrollable**. The list was capped at the
  visible viewport with no `overflow-y` — only the first 1–2 projects ever
  showed. Added `min-h-0 overflow-y-auto` to the projects `<nav>` so the
  list scrolls when it exceeds available height.
- **RunView had a fixed `h-[calc(100vh-7rem)]`** that clipped everything
  below the kanban (autopilot panel, error tasks) on shorter viewports.
  Switched to `min-h-[calc(100vh-7rem)] pb-6` so the page can grow and the
  main scroll-container of the shell takes over when needed.
- **Run-header double label** (`ABGEBROCHEN (ABGEBROCHEN)`). The status
  pill rendered both `status` and `outcome` even when they were identical
  (cancelled/cancelled, failed/failed). Now only adds the parenthetical
  when outcome carries new information.
- **TopBar showed a permanently-disabled "Run pausieren" button** on the
  run-active path. Removed — pause/resume already lives in
  `RunHeaderActions` inside the run card, where it's contextual to the
  run's state. Also removed the orphaned `Pause` icon import.
- **TaskCard 3-column metric grid overlapped** in narrow kanban columns
  (~125px content width). TOKEN / TURNS / DAUER labels and values
  collided. Replaced with a vertically stacked `<dl>` of label-value
  rows that read cleanly at any column width.

### Added

- **Saved-indicator on AutopilotToggle** (`apps/dashboard-web/src/components/AutopilotToggle.tsx`).
  Tracks a last-saved snapshot. Button cycles `Speichern → Speichere… →
  Gespeichert ✓` and disables itself in the clean state. Any field edit
  re-enables it. `runView.autopilot.saved` i18n key added in en + de.

### Verified live

| Surface | Before | After |
| --- | --- | --- |
| Sidebar | 1 project visible, no scrollbar | 778 px content scrolls in 53 px viewport; `preflight-test` reachable |
| RunView | clipped at kanban, no scroll | full page scrolls, n14 / n15 task cards visible |
| Run header | `ABGEBROCHEN (ABGEBROCHEN)` | `ABGEBROCHEN` once |
| TopBar | disabled "Run pausieren" stub | clean Zeit / Turns / Tokens row |
| Autopilot | no save state | toggle → Speichern; save → Gespeichert ✓; edit → Speichern |
| TaskCard | TOKEN/BURNS/DAUER overlap | clean stacked label-value rows |

## 1.7.4 — Repo-not-initialized recovery: preflight + one-click init

Real-world bug: the user locked + started a plan against `C:/.../Wertzeit-ST-App`
which existed as an empty directory but was not a git repo. The first
`git worktree add` failed with a cryptic `fatal: not a git repository`, every
downstream task cancel-cascaded, and the run died in ~50 ms with no useful
surface in the UI.

### Added

- **Run-start preflight** (`apps/dashboard-server/src/routes/runs.ts`).
  Before invoking the runtime, `POST /api/runs` now resolves the project from
  the plan and checks `<repoPath>/.git`. On miss it returns
  `HTTP 400 { error: 'repo_not_initialized', projectId, repoPath, repoPathExists, hint }`
  so the client can offer a structured recovery instead of an opaque
  "Lock & Run failed" toast. New unit test
  (`apps/dashboard-server/src/__tests__/runs.test.ts`) asserts the
  preflight short-circuits before `runtime.startRun` is called.
- **Idempotent init-repo endpoint** `POST /api/projects/:id/init-repo`
  (`apps/dashboard-server/src/routes/projects.ts`). Runs `git init -b main`,
  sets a neutral committer identity if missing, disables signing for the
  bootstrap commit, creates a README from the project's name + goal, and
  commits. Returns `200 { alreadyInitialized: true }` on a repo that is
  already a git repo. Refuses with `400 repo_path_missing` if the directory
  itself does not exist — we don't create arbitrary directories on the
  user's filesystem. 4 new unit tests cover happy / idempotent / missing-dir
  / unknown-project paths.
- **Recovery banner** in PlanEditor
  (`apps/dashboard-web/src/routes/PlanEditor.tsx`). On the `repo_not_initialized`
  error path, the UI replaces the failure toast with an inline banner that
  shows the repoPath plus an "Initialize repo" button. On click, calls the
  new endpoint via `useInitProjectRepo` and re-triggers Lock & Run in the
  same handler, so the user goes from broken state to running run in one
  click. Strings localized in en + de.

### Fixed

- The existing run-route tests previously hid behind fake runtimes and
  fictional `/tmp/r` paths that the preflight would now reject. Test
  fixtures (`runs.test.ts`, `auth-block.test.ts`) updated to create real
  temp git repos in `os.tmpdir()` so the preflight is exercised honestly
  rather than bypassed.

### Verification

| Gate | Result |
| --- | --- |
| Unit + compliance tests | 467 passing (+5) |
| Init-repo endpoint (live) | 201 first call, 200 idempotent, `.git` on disk |
| typecheck / lint / format:check / tokens:check / encoding:check | clean |

## 1.7.3 — Live-test pass: chat scroll, experiments removal, modal i18n

Found by actually using the dashboard (not just running tests). The user hit
two bugs in v1.7.2 that automated gates missed:

- `/chat` was unusable: composer pushed below the viewport, transcript wouldn't
  scroll. Classic flex `min-height: auto` overflow trap on the inner
  `flex-1 overflow-y-auto` containers.
- "show layout experiments (20 variants)" toggle still visible on Home — 20
  dead links to never-registered `/mc/*` routes.

Live-verifying every claim from this iteration on with Playwright; see new
`feedback_use_browser_tools_directly` memory.

### Fixed

- **Flex scroll containers across 4 routes** got `min-h-0` so the inner
  `flex-1 overflow-y-auto` actually scrolls instead of pushing siblings
  off-screen: `routes/Chat.tsx` (left thread list, mid transcript, right
  participants, AddMember modal body), `routes/Agents.tsx` (Edit/Create
  modal body), `routes/PlanEditor.tsx` (node-editor sidebar),
  `routes/RunView.tsx` (Kanban columns).
- **Dev-only injection in production HTML**: `apps/dashboard-web/index.html`
  contained an `impeccable-live` script tag pointing at `localhost:8400`,
  triggering a `ERR_CONNECTION_REFUSED` console error on every page load.
  Removed.
- **Agents create/edit modal i18n**: every label, placeholder, button, error
  message in `AgentDialog` was hardcoded English in an otherwise German UI.
  Added 18 new keys (`agents.dialog.*`) in en+de locales and wired them
  through `t()`.

### Removed

- **`/mc/*` experiments toggle and 20 dead links** from
  `apps/dashboard-web/src/routes/Home.tsx`, plus the `showVariants`
  state + `mc-show-variants` localStorage key. Routes were never
  registered in `App.tsx` so the links 404'd on click.

### Verification

| Gate | Result |
| --- | --- |
| Unit tests | 462 passing |
| Live Playwright probe | 0 console errors, composer in viewport, transcript scrollable, modal in German |
| typecheck / lint / format:check / tokens:check / encoding:check | clean |

## 1.7.2 — Hotfix: chat error-pill contrast in dark mode

CI hotfix for v1.7.1. Re-enabling axe `color-contrast` (v1.7.1, §6.A) exposed
one missing case that didn't repro locally: the three small inline error
tags in `routes/Chat.tsx` (warning + 2 destructive variants) used
`text-{tone}` on `bg-{tone}/20`, which is structurally low-contrast (3.91:1
in dark mode) because the foreground and background share hue/luminance.

The pill only renders when a chat message has `errorReason` set — locally
the test env has `claude` on PATH so the spawn never fails; CI ran into
`ENOENT` and rendered the pill, surfacing the violation.

### Fixed

- `routes/Chat.tsx` error pills: tone-tinted background retained for
  semantic signal, but the text switches to `text-foreground` so contrast
  clears AA in both themes (≥9.6:1 in dark, ≥14:1 in light).

## 1.7.1 — Punch-list close: a11y full-AA, code-split, encoding guardrail

End-to-end hygiene pass closing every item on the v1.7.0 §6 punch list. No
new product features — just shipping the deferred quality work so the v1.7.0
foundation is actually verifiable end-to-end. Full gate green:
typecheck / lint / format:check / tokens:check / encoding:check /
462 unit + compliance tests / 52 Playwright (en+de) + 2 expected skips.

### Added

- **`--muted-foreground-soft` design token** (`apps/dashboard-web/src/index.css`)
  with theme-paired values (light `215 14% 45%`, dark `215 18% 58%`) that
  clear WCAG-AA 4.5:1 against the card background. Wired through `@theme` as
  `--color-muted-foreground-soft` so the `text-muted-foreground-soft` utility
  is generated by Tailwind v4. Use anywhere you'd previously reach for
  `text-muted-foreground/{50..80}` on body text.
- **Mojibake CI guardrail** (`scripts/check-mojibake.cjs` + `pnpm encoding:check`
  + CI step). Detects UTF-8 → Latin-1 → UTF-8 double-encoding via four
  signature regexes (C2+low, C3+low, E2+glyph, F0+178). Output uses `\uXXXX`
  escapes so CI logs themselves stay mojibake-safe. Closes a class of bug
  that had recurred in v1.6.0, v1.6.1, and v1.7.0 because every text-based
  gate (tsc / eslint / prettier / vitest / playwright text matchers) sees
  double-encoded bytes as valid UTF-8 and passes.
- **WS upgrade pre-validation** (`apps/dashboard-server/src/ws.ts`). The
  `/ws/runs/:runId` route now does a primary-key lookup before switching
  protocols and rejects unknown ids with 404. New unit test
  `apps/dashboard-server/src/__tests__/ws.test.ts` asserts the
  `unexpected-response` status. Server test count: 211 → 212.

### Changed

- **Bundle code-splitting** (`apps/dashboard-web/{src/App.tsx,vite.config.ts}`):
  every non-Home route is now `React.lazy` + `Suspense`; Home's chart
  components (`TokenAreaChart` + `OutcomeDonut`) are also lazy so recharts
  drops off the initial-paint path. `rollupOptions.output.manualChunks`
  splits vendor groups (`react-flow`, `charts`, `radix`, `dnd-kit`,
  `react-vendor`, `i18n`, `icons`). **Initial JS payload: 432 → ~181 kB
  gzip.** No more Vite chunk-size warning.
- **axe `color-contrast` rule re-enabled** in `tests/e2e/a11y.spec.ts`.
  Replaced `text-muted-foreground/{50,60,70,80}` with `text-muted-foreground-soft`
  at 8 visible-text call sites (AgentChat, Home, Sidebar, Skills,
  PromptBundles, PlanCanvas, TemplatePicker). `/30` and `/40` on `aria-hidden`
  decorative icons (empty-state, breadcrumb chevrons) intentionally untouched.
  All 16 a11y tests (8 pages × 2 locales) green under the full WCAG-AA rule
  set.
- **Root `pnpm test` no longer triggers e2e.** Script narrowed to
  `--filter "./packages/**" --filter "./apps/**" --filter "./tests/compliance"`.
  Fast feedback loop, no more `:4499` `EADDRINUSE` collisions when running
  unit + e2e back-to-back.
- **README § Development**: documented the two-terminal split for running
  the dashboard locally on Windows, including `Start-Process` / `nohup`
  patterns so a long verification pass doesn't take the dev backend down on
  a parent shell reap.

### Removed

- **`KpiTile` orphan** (`apps/dashboard-web/src/components/home/KpiTile.tsx`).
  Zero imports after the v1.7.0 Home redesign replaced the 4-card hero with
  an inline metric strip.

### Verification

| Gate | Result |
| --- | --- |
| Unit + compliance tests | 462 passing |
| Playwright (en+de) | 52 passing + 2 expected skips |
| axe color-contrast | green on 8 pages × 2 locales |
| Initial JS bundle | ~181 kB gzip (target <300) |
| Encoding check | clean (278 files) |

## 1.7.0 — Design polish pass: foundation components, surface refactors, motion

End-to-end design refinement driven by `ui-ux-pro-max` + `impeccable` critique
of every route in light + dark. Eliminated the three "absolute-ban" patterns
(left side-stripes, hero-metric template, generic version badge) and the
"AI slop" tells that kept the dashboard reading as a template instead of
a Linear-class product. Eight commits worth of changes, batched.

### Added — foundation components

- **`<StatusPill>`** (`components/ui/status-pill.tsx`) — single status pill
  with three variants (`solid` / `soft` / `outline`) × five tones (neutral,
  info, success, warning, destructive), optional pulsing live dot, optional
  leading icon. Consolidates ~7 scattered status-badge call sites across
  Workers/Skills/RunView/ProjectDetail/Sidebar. All UPPERCASE 11px,
  `rounded-full`, `tracking-wider`.
- **`<EmptyState>`** (`components/ui/empty-state.tsx`) — reusable empty state
  with `page` and `column` sizes. Page-size: 64px icon + heading + helper +
  CTA. Column-size: 32px icon + compact title. Used by Goap, Insights
  (3 subsections), RunView kanban (5 columns).
- **`<Logomark>`** + `assets/logomark.svg` — geometric segmented-hex
  identity mark, `currentColor` single-path. Replaces the placeholder
  shadcn `Badge` in the sidebar header and grows into the breadcrumb home
  crumb at 16px.
- **`lib/role-color.ts` `rolePillStyle(role)`** — extends the role-color
  palette with a `{ background, color, borderColor }` triplet using
  opacity-modulated saturated color so role pills adapt to theme background
  via composition (no per-theme override).

### Changed — surface refactors

- **Sidebar brand block**: logomark + wordmark with mono `tabular-nums`
  version below — replaces the placeholder Badge pill.
- **Sidebar project list**: rows truncate cleanly via `flex min-w-0 flex-1`,
  `LOCKED` shows as an outline StatusPill, daily-count uses solid /
  destructive StatusPill at threshold ≥5 else soft / neutral. Whole row
  wrapped in a Radix Tooltip with project name + createdAt.
- **Breadcrumbs**: intermediate crumbs `text-muted-foreground font-medium`,
  final crumb `text-foreground font-semibold`. Home crumb uses the
  logomark at 16px instead of a generic LayoutGrid icon. Lucide
  `ChevronRight size-3.5` separator.
- **Home Mission Control**: removed the 4-card KPI hero. New
  `home-metric-strip` is a single inline `grid-cols-4 divide-x` band —
  active-runs is the headline (`text-3xl`), others `text-2xl`, all
  `tabular-nums`. Soft `bg-success/5` lights up the strip when runs are
  live.
- **OutcomeDonut**: when total ≤5 OR a single outcome dominates >90%, the
  donut is replaced by a stat row (`<dot> Failed · 3 of 3 (100%)`) — the
  chart only renders when a distribution actually exists.
- **RunView task cards**: removed the role-color left side-stripe and the
  `pl-2` overrides that existed to clear it. Role moves to a top-of-card
  token (`<dot> + UPPERCASE label`). Cards gain a subtle `ring-1 ring-info/40`
  while running, `ring-destructive/40` when failed. Per-card status uses a
  soft StatusPill (`live` when running).
- **RunView resource bar**: 3 stacked progress bars + separate token line
  consolidated into a single horizontal 3-segment bar — TIME / TURNS / POOL
  each as eyebrow + tabular value + thin colored fill. Token I/O caption
  right-aligned beneath.
- **RunView header status**: solid StatusPill with live dot during
  running/verifying.
- **RunView kanban empty columns**: replaced "empty" text with EmptyState
  (column size) per column (Clock / Activity / ShieldCheck / CheckCircle2 /
  XCircle).
- **PlanCanvas nodes**: dropped the 4px colored top stripe. Role chip is
  now a low-chroma tinted pill via `rolePillStyle()` — saturated text on
  pale tint, theme-adaptive.
- **PlanCanvas background**: `BackgroundVariant.Dots` `gap={24} size={1}
  color="hsl(var(--border))"` — subtle but visible dot grid.
- **PlanCanvas controls**: custom 3-button IconButton stack
  (`ZoomIn / ZoomOut / Maximize2`) bottom-right with the standard card
  surface — replaces the default ReactFlow `<Controls />` glyph trio.
- **Chat bubbles**: user bubble pinned with `rounded-2xl rounded-tr-md`,
  assistant bubble has no fill (plain text on background),
  receipt cards now lead with a lucide icon (`CheckCircle2 / Info /
  XCircle`) tied to action status — color is no longer the only
  signal.
- **Cards** (`components/ui/card.tsx`): dark mode drops the visible border
  for an inset 1px ring at 50% (rises to 70% on hover) + faint drop
  shadow, anchoring cards instead of letting them float on the dark
  surface. Light mode keeps the border at rest and adds `shadow-sm` on
  hover. All transitions use `--duration-base var(--ease-smooth)`.
- **Button motion**: replaced `transition-colors` with explicit
  `background-color`/`color` on `--duration-quick` and `box-shadow` on
  `--duration-base`, both `--ease-smooth`. The "Linear-style" feel only
  arrives when the motion tokens are actually wired.
- **Data legibility**: `tabular-nums` added to Insights trajectories time
  column, Workers history started/ended cells, GlobalRunsTable started
  column. Workers cron expressions become `font-mono text-xs2
  tracking-wide` so they read as data rather than prose.
- **Empty states on data pages**: Goap result area, Insights three
  subsections (trajectories, run-summaries, router-priors), each
  wrapped in `border border-dashed border-border/40 rounded-md` so the
  empty surface signals intent.

### Fixed — a11y + encoding

- `<main>` scrollable region now has `tabIndex={0}` + `aria-label="Main
  content"` — axe `scrollable-region-focusable` rule passes in both
  locales on the previously-overflowing Insights page.
- Insights `overflow-x-auto` table wrappers have `tabIndex={0}` +
  `role="region"` + `aria-label` per table.
- Mojibake reintroduced by subagent edits hit four files across the run
  (em-dash `—`, ellipsis `…`, middle dot `·`, arrow `→`, plus
  box-drawing characters in JSDoc). Detection regex extended to
  `Â·|â†|â€|â”|â–|â—|ðŸ|Ã[…]`. ASCII-art JSDoc in `Chat.tsx` replaced
  with plain prose to permanently remove the corruption vector for
  box-drawing chars.

### Numbers

- 461 unit tests passing (+19 new from Wave A: StatusPill + EmptyState +
  Logomark; +0 net from refactors).
- 16/16 a11y e2e tests passing (Insights regression fixed).
- 50+ smoke/tooltip/i18n e2e tests passing in both en and de.
- Static gates green: typecheck, lint, prettier, tokens:check, build.
- Bundle size unchanged at 1.44 MB minified / 432 kB gzip.

### Not done (deferred to v1.7.1+)

- Bundle code-splitting (1.44 MB minified is past Vite's 500 kB warning).
- Re-enable `axe-core` `color-contrast` rule in `tests/e2e/a11y.spec.ts`
  — still requires the opacity-modifier audit deferred since v1.6.0.

## 1.6.1 — QA sweep: visual, contrast, role-color, i18n DE

Multi-agent QA pass after v1.6.0 ship. Four parallel test agents (unit/e2e,
static, API, visual screenshots × 48 variants) surfaced one P1 visual bug,
one P1 contrast bug, and a handful of P2 contrast + i18n + truncation
issues. All fixed and verified with re-screenshots in light + dark × en + de.

### Fixed

- **Mojibake** (`Â·`, `â†↗`) in `Chat.tsx` and `AgentChat.tsx` — 9 stray
  double-encoded characters introduced during the v1.6.0 i18n migration.
  All cleaned back to `·` and `→`.
- **Plan-canvas role badges & node stripes invisible in light theme**
  for any role outside the hardcoded `architect | developer | qa` set
  (real plans use `backend-dev`, `qa-engineer`, etc.). Root cause: code
  read `hsl(var(--role-${role}))` for arbitrary strings — undefined
  variable → no fill. Replaced with deterministic JS palette
  `apps/dashboard-web/src/lib/role-color.ts`: canonical roles get
  curated colors, unknown roles hash to a stable 8-color fallback.
  RunView's hardcoded `ROLE_STRIPE` map gone; both surfaces now use
  the same `roleHsl()` / `roleStripeStyle()` helpers.
- **Translucent-tint + white-text contrast bug** in three places (Agents
  dialog model selector, Agents dialog Allowed Tools pills, AgentChat
  active thread row): `bg-info/15` paired with `text-info-foreground`
  rendered white-on-pale-blue → invisible in light theme. Swapped to
  `text-info` (saturated color) which reads cleanly on both light and
  dark tints.
- **Destructive token nudge** — `--destructive` light lightness 60% → 48%
  so white-on-destructive (Cancel button, FAILED badges, delete dialogs)
  passes WCAG-AA. Cascades to every destructive surface.
- **Team-Builder role-card title truncation** — `<CardTitle>` had
  `truncate` without `flex-1 min-w-0`, so titles like `backend-dev`
  collapsed to `backe...`. Now `min-w-0 flex-1 truncate sm:overflow-visible
  sm:whitespace-normal` — truncates only at very narrow viewports.
- **i18n DE gaps**: `OUTCOME` → `Ergebnis`, `Load example` → `Beispiel
  laden`, `Pick tools` → `Tools auswählen`, model costClass + notes
  helper text now translated, `Agents.tsx` `fmtRel` replaced with the
  locale-aware `lib/fmt-rel.ts` so "23h ago" → "vor 23 Stunden".
  Bundle parity: 609/609 keys.
- **Prettier**: `docs/INVENTORY.json` reformatted.
- **Lint hygiene**: `audit-artifacts/**` added to eslint ignores
  (page.evaluate scripts have legitimate `localStorage` references that
  ESLint can't analyze).

### Tests

- New `tests/e2e/wave3.spec.ts` — extended e2e coverage:
  - Chat: full thread create → send → reply → participants → add-member
    dialog → persist across navigation.
  - Project happy-path: create → save team → generate plan → lock & run
    → DONE with all task cards reaching their terminal columns.
  - Both run only on `chromium-en` (i18n covered elsewhere).
- Wave 4 + final verification artifacts under
  `audit-artifacts/screenshots/v1.6.0-wave4-*.png` (48 shots),
  `v1.6.0-final-{plan,run}-{light,dark}-{en,de}.png` (8 shots), and
  `v1.6.1-agent-dialog-{light,dark}.png`.

### Numbers

- 442 unit tests passing (unchanged baseline).
- 52 e2e tests passing + 2 expected skips (wave3 DE).
- All static checks green (typecheck / lint / format / tokens).
- Bundle: 1.44 MB minified, 432 kB gzip (unchanged; chunk-split deferred).

### Deferred to v1.6.2

- **Color-contrast follow-up**: `axe-core`'s `color-contrast` rule
  still disabled in `tests/e2e/a11y.spec.ts`. The base-palette nudges
  covered solid pairs, but opacity modifiers like `text-muted-foreground/60`
  on dark card backgrounds still fall below 4.5:1. Resolution path:
  audit every `/{N}` opacity usage, either bump the base token or
  introduce a dedicated `text-muted-foreground-soft` token with its
  own AA-passing value per theme, then re-enable the rule.

## 1.6.0 — i18n + design tokens + tooltip coverage

Audit follow-up sweeping the three items deferred from v1.5.0: full i18n
migration of the five complex pages, ui-ux-pro-max design-token migration
with a primitive layer, and tooltip + a11y coverage on every interactive
button.

### Phase 1 — Tooltips + a11y

- New `IconButton` wrapper (`apps/dashboard-web/src/components/ui/icon-button.tsx`)
  combines Radix Tooltip + Button + required `aria-label` into one component
  — makes a11y the path of least resistance for icon-only triggers.
- Tooltips wired up on every icon button across Sidebar, TopBar, LanguageToggle,
  ThemeToggle, Chat (new-thread, send, add-member, remove-member), RunView
  (pause, resume, cancel, resume-now), TeamRoleCard (move-up, move-down,
  remove), PlanEditor (regenerate, lock & run).
- Fixed missing aria-label on `Chat.tsx` new-thread + send buttons,
  `Goap.tsx` textareas, and `AgentChat.tsx` agent-selector `<select>`.
- New e2e spec `tooltips.spec.ts` enforces every visible button has an
  accessible name on every page in both en + de.

### Phase 2 — i18n migration of 5 complex pages

- Migrated Chat (869 LOC), Home (407 LOC), RunView (870 LOC),
  TeamBuilder (443 LOC), PlanEditor (553 LOC) and their sub-components
  (AgentChat, Avatar, AvatarPicker, GlobalRunsTable, KpiTile,
  LiveNowGrid, OutcomeDonut, TokenAreaChart, TeamRoleCard,
  ApplyTemplateDialog, TeamJsonDialog, CostEstimatePanel, FirstRunModal,
  PlanCanvas, PlanVersionBadge, RunStore, AutopilotToggle, StatusDotBadge).
- ~180 new translation keys added to both `en/common.json` and
  `de/common.json` with top-level key parity enforced.
- Shared helpers in `apps/dashboard-web/src/lib/`:
  - `fmt-rel.ts` — `fmtRel(date, lang)` using `Intl.RelativeTimeFormat`
    for locale-aware "5 minutes ago" / "vor 5 Minuten".
  - `status-labels.ts` — `statusLabel(status, t)` maps status enum to
    translated label via the shared `status.*` namespace.
- `StatusDotBadge` now i18n-aware by default; every consumer gets
  translated status strings for free.

### Phase 3 — Design-token migration

- New `apps/dashboard-web/src/styles/tokens-primitive.css` — Layer 1
  raw values (color scales, spacing, type scale including `text-3xs`/`text-2xs`/
  `text-xs2`/`text-sm-tight` for the 9/10/11/13px sub-xs sizes that the
  dashboard's dense badges legitimately need, shadow scale, z-index scale,
  letter-spacing scale).
- New `apps/dashboard-web/src/styles/tokens-component.css` — Layer 3
  component-specific aliases (button, input, card, dialog).
- New Tailwind utilities wired through `@theme`: `text-3xs`, `text-2xs`,
  `text-xs2`, `text-sm-tight`, `tracking-widest`.
- All 82 arbitrary Tailwind values (`text-[Npx]`, `tracking-[…]`, etc.) eliminated.
- One hex literal (`#67e8f9` placeholder in Agents.tsx color dialog) moved
  to the i18n bundle as `agents.dialog.colorPlaceholder`.
- New `apps/dashboard-web/scripts/validate-tokens.cjs` validator + companion
  `validate-tokens.test.cjs` lock-down test caps the `h-[calc(…)]` allowlist
  size. Wired as `pnpm tokens:check` and into `.github/workflows/ci.yml`.
- WCAG-AA color-contrast token nudges to `--muted-foreground`, `--info`,
  `--warning-foreground` in both light and dark themes (most contrast pairs
  now pass AA; the remaining ones — `text-muted-foreground/60` and similar
  opacity-reduced variants — are tracked as follow-up in the
  a11y spec).

### Test infrastructure

- New `tests/e2e/helpers/`:
  - `set-lang.ts` — pre-seed `agent-harness-lang` in localStorage so the
    SPA boots straight into the chosen locale.
  - `locator-by-key.ts` — `tt(lang, key, vars?)` resolves dotted i18n
    keys against the on-disk bundle without going through a running app.
- `tests/e2e/playwright.config.ts` now runs every spec in two projects:
  `chromium-en` (locale `en-US`) and `chromium-de` (locale `de-DE`).
- New e2e specs: `a11y.spec.ts` (axe-core scan), `i18n.spec.ts` (per-page
  heading match), `tooltips.spec.ts` (every button has an accessible name).
- `pretest:e2e` rebuilds dashboard-web + dashboard-server before every
  local e2e run so tests never run against a stale bundle.
- Added `@axe-core/playwright` as a dev dep on the e2e package.

### Notable removals

- Local `fmtRel` stubs in `Chat.tsx`, `AgentChat.tsx`, `Agents.tsx` —
  replaced with the shared i18n-aware helper.

## 1.5.0 — Audit pass: backend hardening + UI primitives

Wall-to-wall audit of the harness. Focus was on correctness, observability,
and consistent UI primitives — not new features. ~9k LOC of dead prototype
code removed; one real production bug fixed (caught by a live manager-run
test).

### Fixed — runtime

- **MCP config path is now absolute** (`apps/dashboard-server/src/orchestrator/mcp-config.ts`,
  `runtime.ts`). The previous code read `process.env.WISP_DATA_DIR ?? '.'`
  directly, bypassing the Zod default in `env.ts`. When the env var was
  unset the per-run config landed at `./mcp-configs/<runId>.json` —
  relative to whatever cwd the server started in. Claude was then spawned
  from the task's worktree cwd and ENOENT'd on the path. Every fresh
  real run was failing on the first task. Switched all `WISP_DATA_DIR`
  reads to `env.WISP_DATA_DIR` (post-Zod default) and resolve
  `mcpConfigPath` to absolute up front. Snapshots dir + templates dir
  got the same treatment.
- **`worker-runs-prune` worker** (weekly, 30-day retention) prevents
  unbounded growth of the `worker_runs` table.

### Fixed — observability

- **`agents.ts` corruption-skip catches now log**. The three places that
  silently swallowed JSON.parse failures on a corrupt `teams.roles_json`
  now warn with the call-site context (`isReferenced`, `forceDelete`,
  `usage`). Same skip-on-fail behaviour at the call sites; the warning
  surfaces the data bug instead of hiding it.
- **`insights.ts:50` unsafe cast removed**. `JSON.parse(row.planJson as
  unknown as string)` — `planJson` is already typed `string` by Drizzle.
  Parse failures now log instead of silent fallback to `null`.
- **`prompt-bundles` DELETE returns 204** (was implicit 200 with body).
- **`insights/trajectories/:id` DELETE returns 204** (same).
- **rmSync failure in `prompt-bundles` DELETE is logged**.

### Fixed — skill discovery

- **Loader frontmatter requirement relaxed**: only `name` and
  `description` are required now; `model` defaults to `'sonnet'` and
  `allowed-tools` defaults to `[]`. Files without any frontmatter at
  all throw a typed `NotASkillError` so callers skip silently instead
  of warning. Result: ~30 plugin/user skills that were being skipped
  with a noisy warning at server boot (e.g. `chrome-devtools-mcp`,
  `superpowers`, `firecrawl`, `mcp-server-dev`) are now discovered.
  Concrete: 5 → 35 reachable skills on a representative dev machine.

### Added — UI primitives

- `Skeleton`, `SkeletonText`, `SkeletonRow` — animated bars to replace
  bare `"Loading…"` text everywhere.
- `EmptyState` — icon + title + body + action, used wherever a list
  was previously a bare `"No data"` line.
- `ErrorBanner` — inline error with retry, used as a fallback when a
  query rejects instead of silently rendering `?? []`.

### Changed — UI polish

- **Sidebar version badge is dynamic** — reads `__APP_VERSION__`
  injected at build time from `apps/dashboard-web/package.json`. No
  more stale hardcoded strings drifting across releases.
- **Sidebar nav labels are i18n** — Team Chat, Agents, Skills, Workers,
  Insights, GOAP Planner, Prompt Bundles all use translation keys.
- **Workers, Skills, PromptBundles, Insights, Goap, Agents** pages
  rewritten with the new primitives + tables wrapped in
  `overflow-x-auto` for mobile + full i18n on page chrome.
- All 23 dead `/mc/v1`–`/mc/v20` + 3 `/mc` compare prototype routes
  removed (~9k LOC). They were unlinked since v1.2.0 picked the
  chosen variant for Home; many had partial dark-mode coverage.

### Audit artifacts

`audit-artifacts/` carries the inventory reports (API routes, frontend,
backend internals) plus baseline screenshots of every page in dark and
light mode. Kept in-tree for the v1.5.0 PR.

## 1.4.0 — Multi-source skills + refreshed avatars

Two user-facing wins: the harness now uses **every** Claude Code skill you
already have (project-local, user-global, plugin-bundled), and the 10
seed-agent + 20 generic profile pictures got a clean new generation.

### Added — Multi-source skill discovery (#38)

- New `apps/dashboard-server/src/skills/discovery.ts` walks all four
  conventional Claude Code skill locations and merges them into one
  registry:
  1. Built-in seed (`apps/dashboard-server/src/skills/seed/`) — ships
     with the harness.
  2. Project-local (`<projectRoot>/.claude/skills/`).
  3. User-global (`~/.claude/skills/`).
  4. Plugin cache (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/`).
- Plugins with multiple cached versions side-by-side (e.g. `superpowers`
  5.0.7 + 5.1.0 + content-hash entries) contribute only their
  lexically-greatest version — a good-enough proxy for "newest".
- **First-loaded wins** on name collisions, processed in the priority
  order above so built-ins and project-scoped skills shadow user-global
  and plugin-bundled ones. Shadowed skills are tracked in
  `DiscoveryStats` for diagnostics but not exposed via the API.
- Each skill carries a `source` tag — `'seed' | 'project' | 'user' |
  'plugin:<name>'` — surfaced by `GET /api/skills`.
- `/skills` web route gains coloured per-source badges (blue=seed,
  emerald=project, amber=user, fuchsia=plugin) plus filter pills with
  live counts.
- `SkillRegistry` constructor accepts three init shapes:
  `rootDir: string` (back-compat), `{ skills: Skill[] }` (explicit
  list), `{ discoveryOpts }` (full multi-source discovery).
- Legacy `HARNESS_SKILLS_DIR` env var still works as a single-root
  escape hatch. New `HARNESS_PROJECT_ROOT` env var overrides
  `process.cwd()` for project-local discovery.

### Added — Refreshed agent portraits

- All 10 seed-agent profile pictures (Marcus, Lena, Diego, Aiko, Sven,
  Priya, Maya, Elena, Javier, Noah) regenerated with Higgsfield Soul V2
  — consistent studio aesthetic, soft natural daylight, light grey
  backdrop, persona-matched outfits and expressions.
- 20-image generic avatar pool for user-created custom agents
  regenerated alongside the seeds, with a broader demographic mix so the
  pool fits any role.

## 1.3.0 — Paperclip-port (6 features)

Ports six high-leverage ideas from the paperclip analysis into the
wisp: cheaper Claude calls (prompt-bundle cache), continuity across
runs (per-project summary), robustness under load (max-turns retry +
atomic checkout), cost-aware orchestration routing (phase-based
Thompson roles), and a CI regression safety net (promptfoo evals).
One Drizzle migration (`0008_paperclip_port.sql`) covers all schema
additions. Three new background workers, one new web route. 33 new
unit/integration tests; full suite stays green (206 dashboard-server,
90 orchestrator).

### Added — Phase-based routing (F1)

- `pickFixed(model, role)` in `router/thompson.ts` — hard-picks a
  model with sentinel sampleId `'NO_OP'` so orchestration phases
  (context-ingest, status-post) don't consume the Thompson sample
  budget reserved for substantive picks.
- `recordOutcome` early-returns on `'NO_OP'` so callers share one
  code path.
- `pickModel('planner')` renamed to `pickModel('planner-substantive')`;
  `/api/insights/router-priors` and the Insights table surface a new
  `phase` column derived from the role suffix.

### Added — Atomic run checkout (F2)

- `runs.checkout_token` column + `tryCheckoutRun(runId, from, to)` /
  `releaseCheckout` transactional helpers under
  `src/checkout/atomic-checkout.ts`. Wraps the paused→running
  transition in a single SQLite transaction so concurrent
  autopilot-tick + manual `/resume` calls can't both win.
- Autopilot tick claims via `tryCheckoutRun` before calling
  `runtime.resumeRun`; `RunRuntime.resumeRun` made idempotent for
  already-`running` input (autopilot pre-flips).

### Added — Prompt-bundle cache (F3)

- `prompt_bundles` table keyed by SHA-256 of
  `(systemPrompt, sortedAllowedTools, model)`. Each bundle owns a
  stable cwd + Claude session id under `<WISP_DATA_DIR>/prompt-bundles/`.
- `RunAgentTurnOpts` gains `cwd?`, `resumeSessionId?`, `bundleKey?`.
  `runAgentTurn` reuses the bundle's cwd (skips `mkdtemp`/`rm` when
  stable) and records captured `task.session-id` events back via
  `recordSessionId(bundleKey, sessionId)`.
- `invokeSkill` looks up / upserts the bundle and threads
  `cwd + resumeSessionId + bundleKey` through to `runAgentTurn`, so
  repeated skill invocations hit Anthropic's prompt cache.
- New `GET /api/prompt-bundles` + `DELETE /api/prompt-bundles/:key`
  routes. New web route `/prompt-bundles` (sidebar entry, lucide
  Database icon) lists cached bundles with reset action.
- `prompt-bundle-evict` worker — daily 04:00 cron, 7-day TTL.

### Added — Run-continuation summary (F4)

- `run_summaries` table (one row per terminal run, FK-cascaded to
  runs + projects).
- `run-summary/summarizer.ts` — `buildTranscript(runId)` produces a
  ≤24KB compact transcript from events; `summarizeRun(opts)` invokes
  the existing `summarize-thread` skill, truncates to 8KB, persists
  with heuristic mode detection (implement/plan/review). Idempotent
  — `INSERT OR IGNORE` semantics + early-return on existing row.
- `RunRuntime` accepts an optional `skillRegistry` dep. On terminal
  outcome, fires a `void (async () => summarizeRun(...))()` IIFE
  alongside the existing trajectory-store hook.
- `run-summary-fallback` worker — 15-minute cron, catches runs that
  terminated without a summary (e.g. server crash mid-hook).
- `getLatestSummaryForProject(projectId)` injected into the planner's
  `additionalContext` alongside ReasoningBank lessons, so a new plan
  inherits state from the prior run.
- `GET /api/insights/run-summaries[?projectId=...]` + a "Recent run
  summaries" section in Insights.

### Added — Max-turns retry (F5)

- Defense-in-depth detection in `subprocess.ts`: primary via
  stream-json `result.num_turns >= maxTurns`, fallback via stderr
  pattern (`/max[- ]turns?\s*(exceeded|reached|exhausted)/i`).
  Emits new `task.max-turns-exhausted` event variant alongside
  `task.failed` with `error: 'max-turns-exhausted'`.
- Walker captures the signal into `runErrorReason = 'max_turns'`
  and propagates via `onRunState` (RunState gains
  `errorReason?: string | null`).
- `runs.error_reason / retry_count / next_retry_at` columns +
  composite index. `persistRunPatch` computes `nextRetryAt` from
  the graduated backoff `[2, 10, 30, 120]` minutes with ±25% jitter.
- `retry-max-turns` worker — 2-minute cron, atomically claims via
  `tryCheckoutRun('failed' → 'paused')`, bumps `retryCount` before
  the resume attempt (crash safety), capped at 4 retries.
- RunView surfaces an amber "Max-turns (N/4 retries, next at …)"
  badge when `errorReason === 'max_turns'`.

### Added — Promptfoo eval harness (F6)

- New top-level `evals/` directory: `promptfoo.config.ts` (provider:
  `anthropic:messages:claude-haiku-4-5-20251001`), one YAML case per
  seed skill (`summarize-thread`, `deep-research`, `doctor`,
  `audit-orphan-runs`, `auto-doc`) plus a `manager-directives.yaml`
  case asserting correct `<<ACTION>>{...}<<END>>` formatting.
- Root `pnpm eval` / `pnpm eval:view` scripts.
- CI `evals` job — opt-in via `vars.RUN_EVALS == 'true'` repo variable
  (secret-gating done inside the step since GitHub forbids
  `secrets.*` in job-level `if:`).

### Fixed

- pnpm peer-dep duplication: promptfoo's transitive
  `drizzle-orm@0.45.2` pulled `better-sqlite3@12.9.0` alongside our
  app's `11.10.0`, causing pnpm to specialize our
  `drizzle-orm@0.36.4` into two physical paths. TypeScript saw the
  exports as distinct types → CI typecheck exploded with 738
  cascading errors. Added `pnpm.overrides: { "better-sqlite3":
  "^11.10.0" }` to collapse the resolution.

## 1.2.0 — Mission Control redesign

Visual + structural overhaul. The dashboard adopts the Linear-cockpit
design DNA (semantic state tokens, motion-token scale, sticky
backdrop-blur topbar, `tabular-nums` everywhere) and the placeholder
`/` welcome card is replaced with a real overview that surfaces every
active run across all projects in one screen.

### Added — foundation polish (#34, Phase 1)

- Semantic CSS vars `--success / --warning / --info` (light + dark)
  plus Vault motion tokens (`--ease-smooth/sharp/spring/power`,
  75/150/200/300/500ms duration scale).
- `<StatusDotBadge>` — Linear-style dot pill with tone mapping for
  every status the harness emits (`running`, `success`, `failed`,
  `pending`, `paused`). Pulse variant for live runs. Replaces three
  hardcoded Tailwind tone-maps in Sidebar, ProjectDetail, RecentRuns.
- `<AnimatedCounter>` — easeOutQuart count-up over 1100ms,
  `prefers-reduced-motion`-aware, tabular-nums.
- `<ThemeToggle>` finally exposes the dormant Zustand theme store as
  a UI control. TopBar gains sticky positioning + backdrop-blur.
- `App.tsx` wraps `<Outlet />` in `max-w-screen-2xl` so the layout
  stops sprawling on 4K screens.
- CSS-only `.border-beam` keyframe (`conic-gradient` + `@property
  --beam-angle`) for active-run cards, with reduced-motion fallback.

### Added — Mission Control home (#34, Phase 2)

- New server endpoint `GET /api/runs?include=project` joins runs →
  plans → projects (no N+1 lookups).
- New server endpoint `GET /api/runs/summary?windowDays=7` — single
  windowed scan producing `activeCount`, `totalRuns`, `totalTokens`,
  `successRate`, `avgDurationMs`, `outcomeCounts`, plus pre-bucketed
  `tokensByDay` / `runsByDay` arrays so the area chart never gaps.
- Recharts via shadcn-style theme variables: `<TokenAreaChart>`
  (area + linearGradient) and `<OutcomeDonut>` (pie with legend +
  percent column).
- `<KpiTile>` (4 tiles: Active runs, Tokens 7d, Success rate,
  Avg duration). Animated counter + tone accent band.
- `<LiveNowGrid>` — cards for runs in `running` or `paused` state
  with the `.border-beam` exclusively on actively running ones.
  Ticking duration timer (1s, no extra fetches).
- `<GlobalRunsTable>` — client-sorted on Project / Started /
  Duration / Tokens.
- `Home.tsx` rewritten end-to-end. EN+DE i18n keys throughout.

### Added — cockpit layer (#34, Phase 3)

- `<CommandPalette>` (cmdk, `⌘K` / `Ctrl+K`) — fuzzy search across
  projects, last 50 runs, quick actions (jump to Mission Control,
  toggle theme). Mounted globally inside the Shell so any route
  can summon it.
- `<Breadcrumbs>` — URL-pattern-based, resolves project ids to
  project names via React Query. Mission Control → Project →
  (Team Builder | Plan Editor | Run id).
- TopBar gains a `⌘K` trigger button between content and theme
  toggle, with kbd hint showing the shortcut.

### Test additions

- 2 new server tests for the global runs and summary endpoints.
- Adjusted `App.test`, `TopBar.test`, and the Playwright smoke spec
  for the breadcrumb/H1 dual-occurrence of "Team Builder".

## 1.1.0 — i18n + project workflow polish

40 commits past v1.0.0. The biggest user-visible additions: a
language toggle (EN default ↔ DE), a dedicated project-detail
overview view, a `Run-again` button on terminal-status runs, and
much richer team-template descriptions. Plus four critical fixes
discovered while exercising the GitHub plugin-install path
end-to-end.

### Added — i18n foundation (#29)

- `react-i18next` + `i18next` + `i18next-browser-languagedetector`
  wired into `apps/dashboard-web`.
- `LanguageToggle` in TopBar — flag + native name dropdown,
  persists to `localStorage['agent-harness-lang']`, navigator-lang
  detection on first load.
- `apps/dashboard-web/src/i18n/locales/{en,de}/common.json` cover
  ~150 strings on the entry-path components: TopBar, Sidebar +
  NewProject dialog, FirstRunModal, plus the new ProjectDetail
  view and richer TemplatePicker.

### Added — richer team templates (#30)

- `templateSchema` extended with optional `useCases`, `bestFor`,
  `notRecommendedFor`, `complexity` (`simple` / `medium` /
  `complex`), `expectedDurationMinutes`. All four built-ins
  populated.
- `TemplatePicker.tsx` rewritten: complexity badge (color-coded),
  duration badge, expand-to-see-detail panel with three labelled
  bullet sections.

### Added — project-detail view + Run-again (#31)

- New `/projects/:projectId` route renders a project overview:
  Goal / Repo path / Team summary cards, Plan-status card with
  three actions (Open Team, Open Plan, Start new run gated on
  locked plan), Run history table with status / outcome /
  duration / tokens / aggregates.
- Sidebar project link now lands on the detail view (was: jumped
  straight into TeamBuilder).
- `RunView` shows a `Run again` button when the run reaches a
  terminal status (`completed | failed | cancelled`), POSTing
  `/api/runs` with the same `planId`.

### Fixed — plugin install path (#26, #27, #28)

The GitHub plugin-install path had three blockers caught only by
running `claude plugin install` end-to-end against the live CLI
(2.1.131). Each was a one-line schema mismatch; subsequent installs
all succeed.

- `marketplace.json` source must be `"./"` (was `"."`).
- `plugin.json` must NOT declare `agents/commands/skills/hooks`
  paths — Claude Code auto-discovers them by directory convention.
- `hooks.json` must wrap events in a top-level `"hooks"` record.

### Fixed — bootstrap + serve-web (#21)

- `scripts/launch-dashboard.{ps1,sh}` auto-bootstrap on first
  invocation (`pnpm install --frozen-lockfile && pnpm build`)
  when `apps/dashboard-server/dist/server.js` is missing. Solves
  the previous "Dashboard server not built" dead-end every fresh
  `claude plugin install` user hit.
- Both launchers now set `WISP_SERVE_WEB=1` so `/` serves the
  SPA instead of returning 404.
- README install path uses the GitHub source
  (`Samuel0101010/wisp-orchestrator`) and the correct marketplace
  name (`agent-harness-local`).

### Fixed — modern stream-json + tool-use events (#22, #23)

- `subprocess.ts:mapCliEvent` extended with an `assistant`-frame
  case that walks `message.content[]` and emits `task.text-delta`
  per `text` item and `task.tool-use` per `tool_use` item.
  `thinking` items skipped (private chain-of-thought stays out of
  the dashboard). Without this, the live tail and per-task
  tool-use stream were silently empty during real-Claude runs.
- `runtime.ts` `task.tool-use` filter removed — events now persist
  + broadcast like every other event type. Live verified against
  `mcp__wisp-memory__memory_set` and `Write` calls.

### Fixed — PowerShell launcher logging (#22)

- `launch-dashboard.ps1` redirects stdout / stderr to
  `server.log` / `server.err.log` in `dataDir`, mirroring the
  POSIX launcher's nohup redirect.

### Changed — license

- All eight `package.json` files + `plugin.json` now declare
  `Apache-2.0` (was `UNLICENSED`). Repository ships `LICENSE`
  (canonical Apache-2.0 text). Repo remains private; the license
  declaration takes effect whenever it (or the plugin via
  marketplace) is made public.

### Docs — final truth pass (#25)

Eight stale claims fixed across `README.md`,
`docs/architecture.md`, `docs/memory-mcp.md`,
`docs/development.md` (M1 framing, route list, table count,
budget defaults, env-var coverage). New `docs/templates.md` and
`docs/replan.md` filled the two original-plan deliverables that
were never written. New `docs/solutions/` entries: replan
branch-prefix carried-over deps (Round 5 CRITICAL),
`claude-cli` session-id capture, better-sqlite3 busy_timeout
(under-write contention).

### Audits

Five rounds of post-v1.0 hardening landed earlier in this cycle
(#14–#20): replan branch-parent for carried-over `done` deps,
session-id capture, MCP `busy_timeout=5000` pragma, recovery
hardening (transaction wrap), pool drain on terminate, kill
race-conditions on Windows, byte-correct `octet_length` for memory
sizes, planner.md role-agnostic rewrite, plus 23 PR-#16/#17
verification corrections.

## 1.0.0 — Personal-use complete

The plan written 2026-05-05 finished as scoped: M1 vertical slice,
M1.5 hardening, plus M2-M5 feature work, plus four `/harness-*`
plugin skills. Six real-Claude validation runs documented under
`docs/real-run-notes.md` (~$15-25 in subscription quota total).

### Added — M2: variable team

- `Team` is a `{roles: AgentSpec[]}` array (1..8 roles, kebab-case
  unique names matching `^[a-z][a-z0-9-]*$`, model enum
  `opus|sonnet|haiku`, systemPrompt 40-4000 chars).
- Drizzle migration `0002_variable_team.sql` rewrites legacy
  `{architect,developer,qa}` rows in place (idempotent).
- Planner `DAG_SCHEMA_BLOCK` describes the new shape; planner prompt
  enumerates configured role names verbatim with cardinality.
- Walker resolves agent via `team.roles.find(r => r.role === ...)`;
  emits `task.failed` with "role 'X' not in team" when the lookup
  misses (checked before worktree allocation).
- Server team route validates the new shape; 6 new endpoint tests.
- Web `TeamBuilder` rewrite: `TeamRoleCard` + `TeamRoleAddButton`
  components, model dropdown, per-role remove, inline duplicate
  detection blocks Save.

### Added — M3: shared-memory MCP

- New workspace package `@wisp/memory-mcp`: stdio MCP
  server exposing `memory.{set,get,list,delete}` backed by per-run
  SQLite WAL.
- Walker spawns the server per task via `claude -p --mcp-config
  --strict-mcp-config`. `SubprocessPool.defaultMcpConfigPath`
  injects the config path so the walker stays oblivious.
- Per-run config + DB live under `<WISP_DATA_DIR>/{mcp-configs,
  memory}/<runId>.{json,db}`.
- Default team `allowedTools` include the fully-qualified
  `mcp__wisp-memory__memory_set/get/list` (delete
  intentionally excluded).
- `docs/memory-mcp.md` — usage, security note, on-disk layout,
  inspection guide.

### Added — M4: team templates

- Four built-in templates: `ts-library` (4 roles), `python-backend`
  (4), `refactor-squad` (3), `data-pipeline` (4). Validated against
  `templateSchema` at module load.
- `GET /api/team-templates` returns built-ins + on-disk user
  templates merged & sorted (on-disk wins on id collision).
- `POST /api/team-templates` writes to
  `<WISP_DATA_DIR>/templates/<id>.json`.
- Web `TemplatePicker` in NewProject dialog (max-h-48, scrollable).
  Goal pre-fills from template's first `suggestedGoal`. "Save as
  Template" Dialog on TeamBuilder.
- `apps/dashboard-server/scripts/copy-templates.mjs` ferries
  template JSONs into `dist/` on build.

### Added — M5: QA-driven replan

- New `parent_plan_id` column on plans (Drizzle migration 0003).
- Walker `replanOnQAFailure` callback. When a `qa`-role task fails
  terminally, walker calls server's `replan.ts` helper which
  composes an extended goal with the QA error context, runs
  `generatePlan`, persists a child plan with `parent_plan_id`
  pointing at the failed plan, and returns it for the walker to
  swap in. Capped at 1 replan per run (`MAX_REPLANS_PER_RUN`).
- Branches namespaced by `v<N>` after replan: v1 keeps the original
  `wisp/<runId>/<taskId>` form; v2+ get `wisp/<runId>/vN/<taskId>`
  to avoid `git worktree add -b` collisions on reused task ids.
- Two new events: `qa.replan-triggered`, `qa.replan-exhausted`.
- `GET /api/plans/:id/chain` walks `parent_plan_id` ancestors
  newest-first.
- Web `PlanVersionBadge` renders "v2 (replanned)" for chain >1, with
  ancestor list in the title attribute. Mounted in PlanEditor +
  RunView.
- `generatePlan` extracted from `routes/plans.ts` into
  `apps/dashboard-server/src/orchestrator/planner-runner.ts` so the
  runtime can call it without going through HTTP.

### Added — Stage 1: foundation hardening

- New `harness.verify-failed` event with `{taskId, attempt,
  failures: [{kind, cmd, exitCode, tail}], output}` payload —
  replaces opaque `exit code 1` with full forensics.
- `composeTaskPrompt` truncates retry-error context to first 30 +
  last 60 lines with `[… N omitted …]` marker (was inflating retry
  prompts to thousands of lines).
- `successCriteria.preflight` runs once before build/test/lint and
  short-circuits the rest on failure with `kind: 'preflight'`.
- `task.usage` parser reads modern `{type:'result', usage:{...},
  num_turns}` frame (token telemetry was always 0/0 before).
- `verification.ts` `defaultExec` injects `CI=true` + `npm_config_os`
  + `npm_config_arch` so pnpm install works correctly across
  worktree-chained `node_modules` and stale global pnpm config.

### Added — Stage 6: plugin skills

- Four `SKILL.md` files under `skills/`: `harness-new-run`,
  `harness-resume`, `harness-inspect`, `harness-diagnose`. The
  dashboard is now optional for the most common workflows.
- `GET /api/runs/:runId/events?limit=&type=` for the diagnose skill.
- `.claude-plugin/plugin.json` bumped to register the `skills`
  directory.

### Changed

- Plugin manifest version bumped to `1.0.0`.

## 0.1.5 — M1.5 Foundation hardening (released as part of M1.5 PR)

### Fixed

- Walker now chains downstream worktrees off parent task branches and
  auto-commits each task's output, so a real Claude run produces
  consolidated artifacts in `<repoPath>` instead of evaporating with
  the worktree (Stage A).
- Rate-limit pause no longer auto-resumes by default
  (`WISP_AUTO_RESUME_RATE_LIMIT` to opt in); auth-probe failure
  blocks `POST /api/runs` with HTTP 503; walker pauses with
  `pausedReason='consecutive-failures'` after 3 consecutive task
  failures.

### Changed

- Balanced runtime defaults — `maxParallel=2` (was 3),
  `budgetMinutes=120` (was 360), `interTaskPacingMs=5000` (new).

### Added

- `tests/compliance` — static guards forbidding direct Anthropic
  endpoints, `x-api-key` headers, and credential file access. CI verify
  step includes the new package.
- Per-project daily-runs counter in sidebar; one-time first-run
  acknowledgment modal explaining ToS responsibility.
- `docs/anthropic-compliance.md`; README "Anthropic Terms of Service"
  section.
- `WISP_AUTO_RESUME_RATE_LIMIT`, `WISP_INTER_TASK_PACING_MS`,
  `WISP_AUTH_MODE` env vars.
- Diamond-dep merge support: multi-parent tasks merge other parents
  into the dependent task's worktree via `git merge --no-ff`.
- Final result branch `wisp/<runId>/result` consolidating all leaf
  task branches at run end.
