# Changelog

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
