# Development

Onboarding for contributors. Assumes you have already run `pnpm install` and `pnpm build` from the repo root.

## Repo layout

```
.
├── .claude-plugin/
│   ├── plugin.json            # plugin manifest consumed by `claude plugin install`
│   └── marketplace.json       # local marketplace registration
├── agents/                    # 4 agent specs (architect, developer, qa, planner)
├── apps/
│   ├── dashboard-server/      # Fastify + Drizzle + WS
│   │   ├── src/
│   │   │   ├── app.ts         # Fastify build (cors, ws, routes)
│   │   │   ├── server.ts      # bootstrap + graceful shutdown
│   │   │   ├── env.ts         # Zod-parsed env vars
│   │   │   ├── db/            # Drizzle setup + migrate runner
│   │   │   ├── orchestrator/  # RunRuntime, recovery, planner spawn glue
│   │   │   └── routes/        # health, projects, plans, runs
│   │   └── drizzle/           # generated SQL migrations (committed)
│   └── dashboard-web/         # Vite + React 19 + Tailwind v4 + shadcn
│       └── src/
│           ├── routes/        # Home, TeamBuilder, PlanEditor, RunView
│           ├── components/    # layout (Sidebar, TopBar), plan (PlanCanvas), ui (shadcn)
│           ├── api/           # client + ws + react-query hooks
│           └── store/         # zustand stores (run, ui)
├── commands/
│   └── harness-dashboard.md   # /harness-dashboard slash-command spec
├── docs/                      # this directory
├── hooks/
│   └── hooks.json             # PreCompact + SessionStart wiring
├── packages/
│   ├── orchestrator/
│   │   └── src/
│   │       ├── subprocess.ts  # runClaude (spawn `claude -p`, NDJSON parser)
│   │       ├── pool.ts        # SubprocessPool, terminateAll
│   │       ├── walker.ts      # DAG dispatch, pause/resume, retries
│   │       ├── worktree.ts    # git worktree helpers
│   │       ├── verification.ts# runVerification (build/test/lint gates)
│   │       ├── rate-limit.ts  # detectRateLimit
│   │       ├── auth.ts        # probeSubscriptionAuth
│   │       └── __tests__/
│   └── schemas/
│       └── src/
│           ├── db.ts          # Drizzle table defs
│           ├── plan.ts        # Plan/TaskNode/Team Zod schemas + validateDag
│           ├── events.ts      # HarnessEvent discriminated union
│           ├── team.ts        # parseTeam, safeParseTeam re-exports
│           └── *.test.ts
├── scripts/
│   ├── launch-dashboard.ps1   # Windows launcher
│   ├── launch-dashboard.sh    # POSIX launcher
│   ├── pre-compact-archive.sh # PreCompact hook
│   └── session-start-cleanup.sh # SessionStart hook
└── tests/
    └── e2e/                   # Playwright end-to-end harness
```

## Common scripts

All run from repo root unless noted.

| Command           | What it does                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `pnpm dev`        | All packages in parallel watch mode.                                        |
| `pnpm build`      | `tsc -b` across the workspace.                                              |
| `pnpm test`       | `vitest run` in each package.                                               |
| `pnpm typecheck`  | `tsc -b --pretty`, no emit.                                                 |
| `pnpm lint`       | `eslint .`                                                                  |
| `pnpm format`     | `prettier --write .`                                                        |
| `pnpm format:check` | `prettier --check .` — what CI runs.                                      |

Per-package: `pnpm --filter @agent-harness/<name> <script>`.

## Adding a new agent role (M2 forward-look)

M1 hardcodes three roles: `architect`, `developer`, `qa`. M2 will lift this. The conceptual extension path:

1. Widen the Zod role enum in [`packages/schemas/src/plan.ts`](../packages/schemas/src/plan.ts):
   ```ts
   export const roleEnum = z.enum(['architect', 'developer', 'qa', 'reviewer']);
   ```
2. Update `teamSchema` from a fixed-slot object to either an array of `AgentSpec` or a record keyed by role.
3. Update the Drizzle `tasks.role` enum in [`packages/schemas/src/db.ts`](../packages/schemas/src/db.ts) and write a migration (`pnpm --filter @agent-harness/dashboard-server db:generate`).
4. Author a new `agents/<role>.md` spec following the pattern in [`agents/qa.md`](../agents/qa.md).
5. Update the TeamBuilder UI ([`apps/dashboard-web/src/routes/TeamBuilder.tsx`](../apps/dashboard-web/src/routes/TeamBuilder.tsx)) to surface the new role card.
6. The Walker requires no changes — it routes purely on `node.role` strings.

Don't ship this as part of an unrelated change; it's an M2 milestone deliverable.

## Testing orchestrator changes

The orchestrator never touches the network in tests. Two seams make this work:

### Mock subprocess binary

`runClaude({ ..., __mockBin: '/abs/path/to/fake.mjs' })` swaps the `claude` binary for an arbitrary executable or `.mjs`/`.js`/`.cjs` script. If the path ends in a JS extension, it is invoked via `process.execPath` (the running Node binary).

Existing fixtures live under `packages/orchestrator/src/__tests__/`. To add a new mock mode:

1. Write a `.mjs` script that prints NDJSON to stdout matching the `HarnessEvent` discriminated union.
2. Optional: emit a rate-limit marker on stderr to exercise pause/resume.
3. Pass it via `__mockBin` from your test (and any fake env via `__mockEnv`).

The walker tests use a fake `WalkerDeps` that swaps the entire pool, worktree, and verify functions — useful when you want pure dispatch logic tests with no subprocesses at all.

### Server-side test setup

`apps/dashboard-server/src/__tests__/setup.ts` wires Drizzle against an in-memory SQLite, runs migrations, and provides per-test isolation. New route tests follow the existing pattern in `runs.test.ts` / `projects.test.ts`.

### End-to-end harness

A Playwright project in [`tests/e2e/`](../tests/e2e) drives the full stack with `HARNESS_SERVE_WEB=1` and `HARNESS_MOCK_CLI=1`, so a single `node dist/server.js` hosts UI + API + WS while subprocesses use the deterministic mock fixture.

```sh
pnpm install                             # installs @playwright/test
pnpm exec playwright install chromium    # one-time browser bundle download
pnpm build                               # produces both dist/ outputs the harness needs
pnpm test:e2e                            # runs the harness from the repo root
```

See [tests/e2e/README.md](../tests/e2e/README.md) for what the suite asserts and how to inspect failures.

## Drizzle workflow

The dashboard server owns the schema (`packages/schemas` declares the tables but does not own the migration history).

| Step                | Command                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| Generate migration  | `pnpm --filter @agent-harness/dashboard-server db:generate`                   |
| Run migrations      | `pnpm --filter @agent-harness/dashboard-server db:migrate`                    |
| Inspect             | Open the SQLite file at `${HARNESS_DATA_DIR}/harness.db` with any SQLite GUI. |

Migrations are committed under `apps/dashboard-server/drizzle/`. They run automatically at server boot via [`runMigrations()`](../apps/dashboard-server/src/db/migrate.ts).

If you change a Drizzle table definition without generating a migration, the server will crash at boot with a schema mismatch — the migrate step is mandatory for any schema edit.

## WebSocket event flow

Single endpoint: `GET /ws/runs/:runId` (upgrades to WS).

```
RunRuntime
  └─ walker emits HarnessEvent
       ├─→ db.insert(events)          # persisted
       └─→ ws.publishToRun(runId, e)  # broadcast
              └─→ all clients subscribed to this run channel
```

The WS bus is a per-process in-memory pub/sub keyed by `runId`. There is no server-side fan-out across processes; M1 assumes single-process deployment.

### Client side

[`apps/dashboard-web/src/api/ws.ts`](../apps/dashboard-web/src/api/ws.ts) opens the connection on RunView mount, deserializes events, and pushes into a zustand store ([`store/run.ts`](../apps/dashboard-web/src/store/run.ts)). The store maintains derived state (kanban columns, resource bar, rate-limit countdown).

### Debugging

1. Inspect events without a UI:
   ```sh
   curl -i -N --http1.1 \
     -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
     -H "Sec-WebSocket-Version: 13" \
     http://127.0.0.1:4400/ws/runs/<runId>
   ```
   Or use `wscat -c ws://127.0.0.1:4400/ws/runs/<runId>`.
2. Tail persisted events:
   ```sh
   sqlite3 "${HARNESS_DATA_DIR}/harness.db" \
     "SELECT ts, type, payload FROM events WHERE run_id = '<runId>' ORDER BY ts;"
   ```
3. Server logs: set `HARNESS_LOG_LEVEL=debug` for verbose route + WS tracing.

## Common gotchas

### Windows paths with spaces

The default repo path `C:\Users\dev\Agent Harness` contains a space. Always quote it in shell commands:

```sh
claude plugin marketplace add "C:\Users\dev\Agent Harness"
```

The PowerShell launcher in `scripts/launch-dashboard.ps1` already handles this; if you write new shell scripts, pass paths as quoted args.

### `better-sqlite3` native build

`better-sqlite3` ships with a native module. On a fresh `pnpm install`, pnpm will prompt to approve build scripts:

```sh
pnpm approve-builds
```

If you skip this, the server will throw at boot with a missing native binding. Re-run `pnpm install --force` after approving.

### pnpm `approve-builds`

Same applies to any other dep with a postinstall (currently just `better-sqlite3`). When updating Node versions, re-approve.

### Subscription auth in subprocesses

The orchestrator deletes `ANTHROPIC_API_KEY` from the spawned subprocess env. If you wrap or shim `runClaude` for testing, do not re-export the parent env wholesale — preserve the deletion. See [`packages/orchestrator/src/subprocess.ts`](../packages/orchestrator/src/subprocess.ts) for the pattern.

### Worktree leakage

Per-task worktrees live under `<repoPath>/../worktrees/`. The Walker removes them on task completion, but a hard kill of the server can leave orphans. The `SessionStart` hook ([`scripts/session-start-cleanup.sh`](../scripts/session-start-cleanup.sh)) cleans those up at the start of each Claude Code session.

### Vite + Fastify CORS

The dashboard-server allows `HARNESS_CORS_ORIGIN` (default `http://localhost:5173`) for the Vite dev server. If you change Vite's port, update this env var or the dashboard will fail with CORS errors at every fetch.

## Cross-references

- [README.md](../README.md) — install, quickstart, configuration matrix.
- [docs/architecture.md](architecture.md) — components, data flow, state machine.
- [docs/agents.md](agents.md) — per-agent contracts.
