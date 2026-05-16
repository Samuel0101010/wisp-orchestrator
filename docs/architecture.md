# Architecture

This document covers the v1.0 system. The first half describes the M1 vertical slice (the foundation that survives unchanged); the [v1.0 layers on top of M1](#v10-layers-on-top-of-m1) section at the bottom covers the M2–M5 + plugin-skill additions. Read alongside the [README](../README.md) and the agent reference in [agents.md](agents.md).

## Goals & non-goals

### Goals

- A single local-first orchestrator that runs a variable-size agent team end-to-end against a user-supplied goal.
- Plan as a first-class artifact: editable in the UI, versioned in SQLite, validated server-side before any subprocess spawns.
- Long-horizon execution: runs that span hours and survive rate-limit windows and abrupt server restarts.
- A live dashboard with sub-second update latency over WebSocket.
- Subscription-only auth (Claude Max). The orchestrator never silently falls back to API billing.

### Non-goals (still v1.0)

- Multi-tenant deployment, hosted SaaS, or auth beyond local-loopback.
- Anthropic-marketplace publication (private plugin only).
- Direct-API mode beyond the existing `WISP_AUTH_MODE=api` stub.

The original M1 non-goals (variable team, shared memory, templates, QA replan) all shipped in M2–M5. See [v1.0 layers on top of M1](#v10-layers-on-top-of-m1).

## Components

```
+------------------------------+
|       dashboard-web          |   React 19 + Vite + Tailwind + shadcn
|  Sidebar, TopBar, routes:    |   reactflow + dagre
|  Home/TeamBuilder/PlanEditor |   zustand store, @tanstack/react-query
|  /RunView                    |
+--------------+---------------+
               |  HTTP /api/*       WS /ws/runs/:id
               v
+------------------------------+
|     dashboard-server         |   Fastify 5 + @fastify/cors + @fastify/websocket
|  routes/                     |   pino logger
|    health, projects, plans,  |
|    runs, team-templates,     |
|    plan-chain, probe-prompt  |
|  ws.ts: per-run channels     |
|  orchestrator/               |
|    runtime.ts (RunRuntime)   |
|    recovery.ts               |
|    planner.ts                |
+--------------+---------------+
               |
   +-----------+------------+-------------------+
   |                        |                   |
   v                        v                   v
+----------+        +---------------+   +-----------------+
| Drizzle  |        |  Walker       |   | SubprocessPool  |
| + better |        |  (pure DAG    |   | claude -p in    |
| -sqlite3 |        |  dispatch)    |   | per-task git    |
|          |        |               |   | worktrees       |
+----------+        +-------+-------+   +--------+--------+
                            |                    |
                     deps via WalkerDeps    spawn/terminate
                            |                    |
                            +---- runVerification ---+
                                  (build/test/lint)
```

### Packages

| Path                        | Responsibility                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/schemas`          | Drizzle DB schema (8 tables) + Zod schemas for `Plan`, `HarnessEvent`, `AgentSpec`, `Team`. Pure types, no I/O.      |
| `packages/orchestrator`     | `runClaude` subprocess runner, `SubprocessPool`, `Walker`, worktree helpers, rate-limit detector, `runVerification`. |
| `apps/dashboard-server`     | Fastify routes, WS, Drizzle wiring, `RunRuntime` (DB + WS adapter for the Walker), recovery, planner-spawn glue.     |
| `apps/dashboard-web`        | React dashboard.                                                                                                     |
| `agents/`                   | Markdown agent specs consumed by Claude Code plugin loading.                                                         |
| `commands/wisp-dashboard.md` | Slash-command surfaced through the plugin manifest.                                                              |
| `hooks/hooks.json`          | PreCompact + SessionStart hook config.                                                                               |
| `scripts/`                  | Cross-platform launchers, hook scripts.                                                                              |

## Data flow: a single run, end to end

1. **Project creation.** User submits `{ name, goal, repoPath }`. The route inserts a `projects` row.
2. **Team configuration.** User edits the 3-role team in the TeamBuilder. The route inserts (or replaces) a `teams` row scoped to the project. `rolesJson` carries the full `AgentSpec[]`.
3. **Plan generation.** Server spawns the planner agent (`agents/planner.md`, model: opus) with the goal and team via `claude -p`. The agent writes `plan.json` in the project repo. The server validates against `planSchema`, checks DAG structural invariants in [`validateDag`](../packages/schemas/src/plan.ts), and inserts a `plans` row with `status='draft'` and `dagJson` set to the validated payload.
4. **Plan editing.** User opens the PlanEditor. PATCH `/api/plans/:id` accepts a partial DAG, re-validates, and overwrites. Locking flips status to `locked`; this is the precondition for starting a run.
5. **Run start.** POST `/api/runs` with `{ planId, budgetMinutes?, budgetTurns?, maxParallel? }` creates a `runs` row (`status='running'`), seeds `tasks` rows from the plan (`status='pending'`, `deps` from the DAG), and hands control to `RunRuntime.startRun`.
6. **Walker dispatch.** `Walker.start` is pure orchestration logic. It walks the DAG, finds nodes with all `deps` satisfied (`done`), and dispatches up to `maxParallel` of them. For each dispatched node:
   1. Allocate a worktree branch via `addWorktree({ repoPath, branchName })`.
   2. Build the prompt from the node's `prompt` plus run-context (architecture path, prior failure tail on retry).
   3. `pool.run(...)` invokes `runClaude` with `cwd = worktreePath`, `model`, `allowedTools`, `maxTurns`, `systemPrompt`. The subprocess inherits `~/.claude/` credentials and has `ANTHROPIC_API_KEY` actively unset.
7. **Per-task event flow.** The `claude -p` process emits NDJSON on stdout. `runClaude` parses each line into a `HarnessEvent`, the Walker forwards via `deps.emit`, and `RunRuntime` does two things in parallel:
   - Inserts a row into `events` (typed payload, `runId`, optional `taskId`, timestamp).
   - Broadcasts to `ws://.../ws/runs/:runId` subscribers via the WS bus.
   Token/turn counters on the task and run rows are bumped from `task.usage` events. A `rate-limit.hit` event triggers pause.
8. **Verification.** When the subprocess exits cleanly, the Walker calls `verify(worktreePath, node.successCriteria)` which runs `runVerification` — sequential `build`, `test`, `lint`, optional `custom` shell commands with per-command timeouts. Result is a `pass` boolean plus failure tails.
   - **PASS:** task transitions to `done`, descendants whose deps are now satisfied become `ready`, dispatch loop kicks again.
   - **FAIL on first attempt:** task transitions back to `pending`, retries counter increments, the next attempt's prompt embeds the failure tail. Max retries: 1.
   - **FAIL on retry:** task transitions to `failed`. Descendants are skipped (status `skipped`); the branch is dead. Other independent branches keep running.
9. **Snapshots.** A timer in `RunRuntime` calls `walker.snapshot()` every 10 minutes (configurable). Each snapshot writes a JSON file under `${WISP_DATA_DIR}/snapshots/` and inserts a `checkpoints` row.
10. **Run completion.** The Walker drains its queue; the run row gets `status='completed'`, `outcome='success'` (all leaf tasks done), `'failure'` (any leaf failed), `'cancelled'` (user cancel), or `'budget_exceeded'` (wallclock or turns cap hit).

## Worktree chaining

Each task runs in its own git worktree, branched off the dependency graph.
Branches are named `harness/<runId>/<taskId>`. The walker:

1. Creates the worktree from the parent task's branch (or from `HEAD` for
   root tasks). Multi-dep nodes branch from the first dep and merge the
   rest in via `git merge --no-ff`; conflicts mark the task as failed.
2. Runs the `claude -p` subprocess in the worktree.
3. On verification success, calls `commitWorktreeChanges` (forced harness
   identity, `--allow-empty`, signing disabled) so the branch tip carries
   the artifacts forward. Without this, downstream tasks would branch off
   an empty parent branch.
4. Removes the worktree directory but keeps the branch.
5. After a successful run, finalizes a `harness/<runId>/result` branch by
   creating a fresh worktree from `HEAD` and `git merge --no-ff`-ing every
   leaf task's branch into it. The user inspects this single branch to see
   the run's full output as a chain of merge commits.

A failed run skips the result-branch finalize step; leaf branches stay
intact for forensics. Multi-dep merge conflicts mark the dependent task
failed without auto-resolution — the worktree is left for the user to
inspect.

## Resilience matrix

| Failure mode                              | Detection                                                                       | Mitigation                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Subprocess crash (non-rate-limit)         | Non-zero exit code, no rate-limit marker                                        | Mark task `failed`. Retry once if first attempt; otherwise terminate the branch.                                                     |
| Verification fail                         | `runVerification.pass=false`                                                    | Same as crash: retry once with failure tail in prompt, then terminate branch.                                                        |
| Rate-limit hit                            | `detectRateLimit(stderr+stdout)` matches markers; emits `rate-limit.hit` event  | Pause walker, set `runs.pausedReason='rate-limit'`, `resumeAt` from JSON `retry_after`/`reset` or default 5 h. Auto-resume on timer. |
| User-initiated pause                      | POST `/api/runs/:id/pause`                                                      | Set `pausedReason='user'`. No timer.                                                                                                 |
| Server abrupt crash                       | On boot, `fixUpAbruptCrashes` finds runs in `running` and marks them `paused`/`shutdown`. | UI surfaces "resumable" runs via `GET /api/runs?resumable=true`.                                                              |
| Graceful shutdown (SIGINT/SIGTERM)        | `shutdown(app, signal)` calls `runtime.pauseAllForShutdown()`                  | Each walker persists state, sets `pausedReason='shutdown'`. 30 s hard timeout, then `process.exit(1)`.                               |
| Budget exhaustion (time or turns)         | Walker's per-tick check                                                         | Emit `resource.exceeded`, terminate dispatch, mark run `outcome='budget_exceeded'`.                                                  |
| Worktree dirty / branch conflict          | `addWorktree` fails                                                             | Surface error to walker, mark task `failed`. Retry policy applies.                                                                   |
| Stale resume after restart                | Walker rebuilt with `initialState` from DB on resume                            | `completedTaskIds`/`failedTaskIds` skipped; `resumableTasks` re-spawned with `--resume <sessionId>` if available.                    |

## Auth model

The harness is subscription-only by design. Every subprocess spawned by `runClaude` does two things:

1. **Inherits `~/.claude/`** — the Claude Code CLI's credential cache lives there; subprocesses transparently authenticate as the logged-in subscription user.
2. **Actively unsets `ANTHROPIC_API_KEY`** — see [`packages/orchestrator/src/subprocess.ts`](../packages/orchestrator/src/subprocess.ts):
   ```ts
   const env = { ...process.env };
   delete env.ANTHROPIC_API_KEY;
   ```
   This prevents the silent fallback path where a stale API key in the parent shell would route to billed API usage instead of the subscription.

`probeSubscriptionAuth` runs at run-start time to verify the subscription path is live before any tasks dispatch. A failed probe surfaces a clear error in the dashboard and aborts the run before any worktrees are created.

The plan for distinguishing Pro vs Max subscriptions (different rate-limit shapes) is to expand `RateLimitHit.source` and the rate-limit reset heuristics in M2; M1 treats both subscription tiers identically.

## Resource budgeting

Three caps gate every run, configured per-run with sensible defaults from `RunRuntime`:

| Budget         | Default | Hard cap?              | Notes                                                                          |
| -------------- | ------- | ---------------------- | ------------------------------------------------------------------------------ |
| `budgetMinutes`| 120     | Yes                    | Wallclock from `runs.startedAt`. Triggers `outcome='budget_exceeded'`.         |
| `budgetTurns`  | 500     | Yes                    | Sum of per-task `turnsUsed`. Same outcome as time exhaustion.                  |
| `maxParallel`  | 2       | Yes                    | Concurrency cap on `SubprocessPool`. Walker honors this when dispatching. Subscription-friendly default. |
| Tokens         | n/a     | No (informational only)| Surfaced as `tokensInTotal` / `tokensOutTotal` for cost transparency, never gated. |

The Walker emits `resource.warning` at 80% and `resource.exceeded` at 100% of each gated budget; the dashboard's TopBar reflects both.

## Rate-limit handling

`detectRateLimit(text)` ([`packages/orchestrator/src/rate-limit.ts`](../packages/orchestrator/src/rate-limit.ts)) scans a buffer for markers (`rate.?limit`, `quota.?exceeded`, `\b429\b`, etc.) and tries to extract an absolute reset time, in priority order:

1. JSON `"retry_after": <seconds>` → `Date.now() + secs*1000`.
2. JSON `"reset_seconds": <seconds>` → same.
3. JSON `"reset": "<ISO-8601>"` → parsed.
4. Fallback: `Date.now() + 5h`.

On hit, the Walker:

1. Aborts the offending subprocess (and any siblings still running).
2. Persists `runs.pausedReason='rate-limit'`, `runs.resumeAt=<computed>`.
3. Inserts a `rate_windows` row for forensics.
4. Schedules a `setTimeout` (via `deps.setTimeout` — testable seam) that resumes the walker at `resumeAt`.

If the server restarts during a paused window, recovery (see below) re-arms the timer based on `runs.resumeAt`. The dashboard's RunView shows a live countdown.

## State machine

### Run states

| State       | Entry                                              | Exit transitions                                                       |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `pending`   | Row created, not yet started                       | `running` (via `RunRuntime.startRun`)                                  |
| `running`   | Walker actively dispatching                        | `paused` (rate-limit \| user \| shutdown), `completed`, `failed`, `cancelled` |
| `paused`    | Set by walker on rate-limit, user pause, or shutdown | `running` (resume)                                                   |
| `completed` | DAG drained successfully                           | terminal                                                               |
| `failed`    | A leaf task failed terminally                      | terminal                                                               |
| `cancelled` | User-initiated cancel                              | terminal                                                               |

Run outcome (set on terminal transition): `success | failure | budget_exceeded | cancelled`.

Task outcome on `task.completed` is always `'pass'` in M1 — verification failure flows through `task.failed`, not a `'fail'` outcome. M5 (QA replan loop) will reintroduce richer task outcomes if needed.

`pausedReason` enum: `'rate-limit' | 'user' | 'shutdown' | 'consecutive-failures'`.

### Task states

| State     | Meaning                                                   | Allowed transitions                                                                |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pending` | Created, deps not yet satisfied (or retrying)             | `ready`, `running` (after retry transition)                                        |
| `ready`   | All deps `done`, awaiting a free pool slot                | `running`                                                                          |
| `running` | Subprocess in flight                                      | `done`, `failed`, `pending` (retry path)                                           |
| `done`    | Subprocess + verification both passed                     | terminal                                                                           |
| `failed`  | First attempt failed verification AND retry also failed   | terminal                                                                           |
| `skipped` | Ancestor `failed` — branch is dead                        | terminal                                                                           |

The Walker also tracks an internal `'paused'` task status used during rate-limit/shutdown bookkeeping; this collapses to `'pending'` when persisted to the DB (see `TASK_STATUS_MAP` in `apps/dashboard-server/src/orchestrator/runtime.ts`).

## Schema reference

See [`packages/schemas/src/db.ts`](../packages/schemas/src/db.ts) for the canonical 9-table Drizzle schema:

- `projects` — top-level container.
- `teams` — per-project team specs.
- `plans` — DAG payload + status.
- `tasks` — denormalized per-node state for fast queries.
- `runs` — execution lifecycle.
- `events` — append-only event log, the source of truth for replay.
- `checkpoints` — periodic snapshot pointers.
- `rateWindows` — observed rate-limit windows for forensics.

Migrations live in `apps/dashboard-server/drizzle/` and run automatically at boot via `runMigrations()`.

## v1.0 layers on top of M1

The same M1 core (Walker / SubprocessPool / Worktree / Verification) carries every later milestone unchanged. v1.0 added:

### M2 — variable team

`Team` is now `{roles: AgentSpec[]}` (1..8, kebab-case unique role names, model enum opus/sonnet/haiku, systemPrompt 40-4000 chars). The walker resolves the agent for a given task via `team.roles.find(r => r.role === node.role)` and emits a graceful `task.failed` ("role 'X' not in team") if the lookup misses. Planner prompt enumerates the configured roles literally so the LLM can't drift to an unknown role. Drizzle migration `0002_variable_team.sql` rewrites legacy 3-slot rows in place.

### M3 — shared-memory MCP

A separate workspace package `@wisp/memory-mcp` ships a stdio MCP server exposing `memory.{set,get,list,delete}` backed by per-run SQLite WAL. The runtime's `writeMemoryMcpConfig` writes a per-run config JSON; `SubprocessPool.defaultMcpConfigPath` injects `--mcp-config + --strict-mcp-config` into every `claude -p` call. Each run has its own `<WISP_DATA_DIR>/memory/<runId>.db` — no cross-run sharing, no network. Tools are exposed to agents as `mcp__wisp-memory__memory_*` (claude converts `.` to `_` in MCP tool names).

### M4 — team templates

`apps/dashboard-server/src/templates/` carries four built-in templates (`ts-library`, `python-backend`, `refactor-squad`, `data-pipeline`). `GET /api/team-templates` merges them with on-disk user templates from `<WISP_DATA_DIR>/templates/<id>.json`. The web UI's `TemplatePicker` (in the New Project dialog) lets users pick + the goal pre-fills from the template's `suggestedGoals[0]`. `apps/dashboard-server/scripts/copy-templates.mjs` ferries the JSONs into `dist/` on build (tsc doesn't copy non-TS files).

### M5 — QA-driven replan

A new `parent_plan_id` column on `plans` (Drizzle migration 0003) links replanned plans back to the failed predecessor. When a `qa`-role task fails terminally, the walker invokes a `replanOnQAFailure` callback. The server's `replan.ts` helper composes an extended goal (original + truncated QA error context), calls `generatePlan` (now extracted to `orchestrator/planner-runner.ts` so it can be called outside the HTTP route), and persists the result with `parent_plan_id` set. The walker swaps in the new plan and continues under the same `runId`.

Capped at `MAX_REPLANS_PER_RUN = 1` to prevent infinite loops. Branches namespaced by version: v1 keeps the unprefixed form (`harness/<runId>/<taskId>`), v2+ get `harness/<runId>/v2/<taskId>` to avoid `git worktree add -b` collisions on reused task ids.

Two new events: `qa.replan-triggered` (success swap) and `qa.replan-exhausted` (cap hit). `GET /api/plans/:id/chain` walks the ancestor chain newest-first; the `PlanVersionBadge` web component renders "v2 (replanned)" for chains > 1.

### Stage 1 — foundation hardening (post-M1.5)

Five tightenings + one cross-platform fix that surfaced during real-Claude validation:

- `harness.verify-failed` event with full payload (`failures[*].kind/cmd/exitCode/tail` + `output`) instead of opaque `exit code 1`.
- `composeTaskPrompt` truncates retry-error context to first 30 + last 60 lines.
- `successCriteria.preflight` runs once before build/test/lint.
- `task.usage` parser reads modern `result`-frame.
- `verification.ts` `defaultExec` injects `CI=true` + `npm_config_os` + `npm_config_arch` so `pnpm install` works against worktree-chained `node_modules` and stale global pnpm config.

### Stage 6 — plugin skills

Four `SKILL.md` files under `skills/`: `harness-new-run`, `-resume`, `-inspect`, `-diagnose`. Each is markdown + YAML frontmatter that Claude Code surfaces via a `/harness-*` slash command. The dashboard becomes optional for the most common workflows. `GET /api/runs/:runId/events?limit=&type=` was added to back the diagnose skill.

### Known limitations

- **Planner-event audit gap.** Planner runs are ad-hoc — they have no parent `runs` row. Their `HarnessEvent` stream is broadcast on the WS channel `planner:<projectId>` for live UI feedback but is NOT persisted to the `events` table (the FK requires a `runId`). On failure, the structured error is in the HTTP 422/503 response and the server log; there is no DB-side audit trail.
- **Replan task token totals not tracked per version.** When a v2 plan reuses a task id from v1, the `tasks` row's `tokens_in`/`tokens_out` columns are overwritten by the v2 task's totals. The `events` table preserves the full history. Future enhancement: composite `(plan_id, task_id)` key on `tasks`.

## Further reading

- [README.md](../README.md) — install, quickstart, configuration.
- [docs/agents.md](agents.md) — per-agent contract.
- [docs/development.md](development.md) — onboarding, gotchas, testing.
