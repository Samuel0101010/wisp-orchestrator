# Changelog

## 0.1.5 - M1.5 Foundation hardening (unreleased)

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
