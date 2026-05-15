# Changelog

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
  `@agent-harness/schemas` — strict Zod validation of agent patches, plus
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
- Schema types in `@agent-harness/schemas`: `ProjectBrief`,
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
  Chromium once into `~/.cache/agent-harness/playwright-browsers`
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
  `harness/<runId>/result` into `main`. Strategy: prefer `git update-ref`
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
  opacity-reduced variants — are deferred to v1.6.1 with a TODO in the
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
  `runtime.ts`). The previous code read `process.env.HARNESS_DATA_DIR ?? '.'`
  directly, bypassing the Zod default in `env.ts`. When the env var was
  unset the per-run config landed at `./mcp-configs/<runId>.json` —
  relative to whatever cwd the server started in. Claude was then spawned
  from the task's worktree cwd and ENOENT'd on the path. Every fresh
  real run was failing on the first task. Switched all `HARNESS_DATA_DIR`
  reads to `env.HARNESS_DATA_DIR` (post-Zod default) and resolve
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
harness: cheaper Claude calls (prompt-bundle cache), continuity across
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
  stable cwd + Claude session id under `<HARNESS_DATA_DIR>/prompt-bundles/`.
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
- Both launchers now set `HARNESS_SERVE_WEB=1` so `/` serves the
  SPA instead of returning 404.
- README install path uses the GitHub source
  (`Samuel0101010/agent-harness`) and the correct marketplace
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
  `mcp__agent-harness-memory__memory_set` and `Write` calls.

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

- New workspace package `@agent-harness/memory-mcp`: stdio MCP
  server exposing `memory.{set,get,list,delete}` backed by per-run
  SQLite WAL.
- Walker spawns the server per task via `claude -p --mcp-config
  --strict-mcp-config`. `SubprocessPool.defaultMcpConfigPath`
  injects the config path so the walker stays oblivious.
- Per-run config + DB live under `<HARNESS_DATA_DIR>/{mcp-configs,
  memory}/<runId>.{json,db}`.
- Default team `allowedTools` include the fully-qualified
  `mcp__agent-harness-memory__memory_set/get/list` (delete
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
  `<HARNESS_DATA_DIR>/templates/<id>.json`.
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
  `harness/<runId>/<taskId>` form; v2+ get `harness/<runId>/vN/<taskId>`
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
  (`HARNESS_AUTO_RESUME_RATE_LIMIT` to opt in); auth-probe failure
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
- `HARNESS_AUTO_RESUME_RATE_LIMIT`, `HARNESS_INTER_TASK_PACING_MS`,
  `HARNESS_AUTH_MODE` env vars.
- Diamond-dep merge support: multi-parent tasks merge other parents
  into the dependent task's worktree via `git merge --no-ff`.
- Final result branch `harness/<runId>/result` consolidating all leaf
  task branches at run end.

## 0.1.0 - M1 vertical slice (unreleased)

The first end-to-end milestone: a single goal can drive a 3-role team through plan generation, execution, and verification, with full pause/resume across rate-limit windows and server restarts.

### Added

- Claude Code plugin manifest (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) plus four agent specs in `agents/` (architect, developer, qa, planner), the `/harness-dashboard` slash-command, `hooks/hooks.json` with `PreCompact` + `SessionStart` wiring, and cross-platform launcher scripts in `scripts/`.
- `packages/schemas` — Drizzle schema with 9 tables (`projects`, `teams`, `plans`, `tasks`, `runs`, `events`, `checkpoints`, `rate_windows`) plus Zod schemas for `Plan`, `HarnessEvent`, `AgentSpec`, `Team`, including `validateDag` for structural plan invariants.
- `packages/orchestrator`:
  - `runClaude` subprocess runner that spawns `claude -p`, parses NDJSON to `HarnessEvent`s, and supports a `__mockBin` test seam.
  - `SubprocessPool` with `terminateAll` for graceful cancellation.
  - `Walker` — DAG dispatch with pause/resume, rate-limit auto-resume timer, budget caps, single-retry policy, and resume-after-shutdown via `initialState`.
  - `runVerification` (E1) running `build`/`test`/`lint`/`custom` shell gates with per-command timeouts.
  - `addWorktree` / `removeWorktree` git helpers for per-task isolation.
  - `probeSubscriptionAuth` and `detectRateLimit` heuristics.
- `apps/dashboard-server`:
  - Fastify 5 + `@fastify/cors` + `@fastify/websocket`.
  - Routes: `/api/health`, projects (CRUD), teams (per project), plans (generate, get, patch, lock), runs (start, get, pause, resume, cancel, replay-checkpoint, list-by-project, global list with `?resumable=true`).
  - `RunRuntime` wiring Walker into DB + WS, with per-run snapshots every 10 minutes.
  - Bootstrap that runs migrations and recovers orphaned `running` runs to `paused`/`shutdown`.
  - Graceful shutdown that pauses every walker with `pausedReason='shutdown'` and closes Fastify + SQLite within a 30 s hard timeout.
- `apps/dashboard-web`:
  - Vite + React 19 + Tailwind v4 + shadcn.
  - Routes: TeamBuilder (3 role cards), PlanEditor (React Flow + dagre layout, side-panel inline edit), RunView (5-column kanban: pending/running/verifying/done/failed; live tail; resource bar; rate-limit countdown).
  - Sidebar with project list, new-project dialog, recent-runs preview.
  - TopBar mirrors run resource bar.
- Documentation: `README.md` rewrite, `docs/architecture.md`, `docs/agents.md`, `docs/development.md`, this `CHANGELOG.md`.

### Notes

- Subscription-only auth: every subprocess inherits `~/.claude/` and has `ANTHROPIC_API_KEY` actively unset.
- Token usage is informational only; the gated budgets are wallclock minutes, total turns, and parallel pool size.
- 167 unit tests plus 1 Playwright end-to-end smoke test (mock-CLI mode) green at M1 close. All packages typecheck and build.

### M1 review fixes (post-close)

- Fixed: rate-limit pauses no longer auto-resume after server restart; `fixUpAbruptCrashes` rewrites them to `paused/shutdown` so the user explicitly resumes (C1).
- Fixed: `task.usage` now treated as cumulative (`Math.max`) on per-task counters; run-level totals updated by delta to match `claude -p --output-format stream-json` semantics (H1).
- Fixed: dropped unused `'concerns' | 'fail'` task-outcome enum values; `task.completed` is `'pass'` only in M1 (H2).
- Fixed: bootstrap now runs a one-shot subscription-auth probe and surfaces the result via `GET /api/health.authProbe` (skipped when `HARNESS_MOCK_CLI=1`); never fails bootstrap (H3).
- Fixed: `teams.rolesJson` stores the slotted `Team` object directly; dropped the legacy array<->object conversion helpers (H4).
- Fixed: walker forwards the per-task abort signal to `runVerification` so cancel/pause halts verifier subprocesses promptly (M1).
- Fixed: documented `runVerification` SIGTERM→SIGKILL escalation (5s grace via execa's `forceKillAfterTimeout`); migrated to execa v9's `cancelSignal` option (M2).
- Fixed: `walker.cancel()` removes worktrees of currently-running tasks on user-cancel; preserves them on `budget_exceeded` for forensics; also calls `pool.terminateAll()` for slot hygiene (M3, L1).
- Fixed: resume path logs structured `resume-no-session` warning when a task with a worktree but no `sessionId` is restarted from scratch (M4).
- Fixed: server-side `emit` filter drops `task.tool-use` events from persistence and WS broadcast; schema entry preserved for future tool-timeline UI (M5).
- Documented planner-event audit gap: events broadcast for live UI, not persisted (no parent `runs` row); listed under architecture.md "Known limitations" (M6).
- Fixed: `recompute()` in `apps/dashboard-web/src/store/run.ts` no longer constructs a dead `aggregates` object (L2).
- Fixed: `PATCH /api/plans/:planId` returns 400 `empty-patch` when `dagJson` is missing (L3).
- Fixed: `scripts/launch-dashboard.ps1` uses `-NoNewWindow` instead of the conflicting `-WindowStyle Hidden` (L5).
