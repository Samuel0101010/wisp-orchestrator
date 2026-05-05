# Architecture

This document describes the M1 vertical slice. It assumes you have read the [README](../README.md) and skimmed the agent reference in [agents.md](agents.md).

## Goals & non-goals

### Goals

- A single local-first orchestrator that runs a 3-role agent team end-to-end against a user-supplied goal.
- Plan as a first-class artifact: editable in the UI, versioned in SQLite, validated server-side before any subprocess spawns.
- Long-horizon execution: runs that span hours and survive rate-limit windows and abrupt server restarts.
- A live dashboard with sub-second update latency over WebSocket.
- Subscription-only auth (Claude Max). The orchestrator never silently falls back to API billing.

### Non-goals (M1)

- Variable team size, variable role types — fixed to architect/developer/QA. Lifted in M2.
- Cross-agent shared memory beyond what the filesystem (`architecture.md`, `tasks.md`, plain commits) provides. Lifted in M3.
- Marketplace-distributed team templates. Lifted in M4.
- QA-driven replan; M1 retries the developer node once and otherwise marks the branch failed. Lifted in M5.
- Multi-tenant deployment, hosted SaaS, or auth beyond local-loopback.

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
|    health, projects,         |
|    plans, runs               |
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
| `packages/schemas`          | Drizzle DB schema (9 tables) + Zod schemas for `Plan`, `HarnessEvent`, `AgentSpec`, `Team`. Pure types, no I/O.      |
| `packages/orchestrator`     | `runClaude` subprocess runner, `SubprocessPool`, `Walker`, worktree helpers, rate-limit detector, `runVerification`. |
| `apps/dashboard-server`     | Fastify routes, WS, Drizzle wiring, `RunRuntime` (DB + WS adapter for the Walker), recovery, planner-spawn glue.     |
| `apps/dashboard-web`        | React dashboard.                                                                                                     |
| `agents/`                   | Markdown agent specs consumed by Claude Code plugin loading.                                                         |
| `commands/harness-dashboard.md` | Slash-command surfaced through the plugin manifest.                                                              |
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
9. **Snapshots.** A timer in `RunRuntime` calls `walker.snapshot()` every 10 minutes (configurable). Each snapshot writes a JSON file under `${HARNESS_DATA_DIR}/snapshots/` and inserts a `checkpoints` row.
10. **Run completion.** The Walker drains its queue; the run row gets `status='completed'`, `outcome='success'` (all leaf tasks done), `'failure'` (any leaf failed), `'cancelled'` (user cancel), or `'budget_exceeded'` (wallclock or turns cap hit).

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
| `budgetMinutes`| 360     | Yes                    | Wallclock from `runs.startedAt`. Triggers `outcome='budget_exceeded'`.         |
| `budgetTurns`  | 500     | Yes                    | Sum of per-task `turnsUsed`. Same outcome as time exhaustion.                  |
| `maxParallel`  | 3       | Yes                    | Concurrency cap on `SubprocessPool`. Walker honors this when dispatching.      |
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

`pausedReason` enum: `'rate-limit' | 'user' | 'shutdown'`.

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

## Extension points (M2-M5 hooks)

The following seams exist explicitly to absorb future milestones without rewriting the M1 core:

- **`Walker.WalkerDeps`** — every side-effect funnels through this interface (pool, worktree, verify, emit, snapshot, setTimeout, now). M2's variable team adds new role types but reuses this seam unchanged.
- **`AgentSpec` / `Team`** — currently a fixed object with `architect | developer | qa` slots. M2 will widen `teamSchema` to an array and add per-role override fields.
- **`HarnessEvent` discriminated union** — new event types append cleanly. M3's shared-memory MCP will add `memory.read` / `memory.write` events; the dashboard's event-tail handles unknown types gracefully.
- **`RunRuntime` planner spawn** — currently calls a single planner agent. M5's QA-replan loop wraps this in a higher-level controller that re-invokes the planner mid-run with QA context.
- **Plan storage** — `plans.dagJson` is a free-form JSON column. M4's template marketplace inserts pre-baked DAGs without any schema migration.

### Known limitations

- **Planner-event audit gap.** Planner runs are ad-hoc — they have no parent `runs` row. Their `HarnessEvent` stream is broadcast on the WS channel `planner:<projectId>` for live UI feedback but is NOT persisted to the `events` table (the FK requires a `runId`). On failure, the structured error is in the HTTP 422/503 response and the server log; there is no DB-side audit trail. M5 may introduce a synthetic "planner run" row to close this gap.

## Further reading

- [README.md](../README.md) — install, quickstart, configuration.
- [docs/agents.md](agents.md) — per-agent contract.
- [docs/development.md](development.md) — onboarding, gotchas, testing.
