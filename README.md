# Agent Harness

Visual team-builder, plan-as-artifact, and live execution graph for autonomous Claude Code agent crews. Spawn a 3-role team, generate a DAG plan, run for hours, watch it ship in your browser.

## What it is

The agent ecosystem today fragments across three categories that do not compose: chat UIs that run a single agent at a time; orchestrators that hide the plan as opaque internal state; and notebooks that demand babysitting. Nothing combines an editable team specification, a plan you can inspect and edit before it runs, and a live execution graph that survives across rate-limit windows and machine restarts.

Agent Harness is a local-first orchestrator for Claude Code that delivers exactly that vertical slice. You describe a goal, configure a 3-role team (architect, developer, QA), generate a plan as a directed acyclic graph, optionally edit it, then lock and run. A `Walker` dispatches tasks via `claude -p` subprocesses pinned to per-task git worktrees, parses streamed events, and persists everything to SQLite. The browser dashboard renders the live state: a kanban board, a streaming text tail, a resource-budget meter, and a rate-limit countdown that survives server restarts.

This repository is the M1 milestone — the smallest end-to-end slice that exercises every layer (plugin, orchestrator, dashboard, persistence). It deliberately omits a number of features queued for later milestones, including: a variable-size team builder beyond the fixed 3 roles, a shared-memory MCP for cross-agent context, a team-template marketplace, and a QA-driven replan loop. See the [Roadmap](#roadmap) for the staged buildout.

## Status

**M1 — vertical slice (E2E).** The code in this repo runs an end-to-end goal-to-PR loop with one team configuration. Subsequent milestones layer features on top of the same orchestrator core.

- M2 — variable team builder and per-role models.
- M3 — shared-memory MCP for cross-agent context.
- M4 — team-template marketplace.
- M5 — QA-driven replan loop.

## Requirements

- Node.js >= 20.10
- pnpm >= 9
- Claude Code CLI (the `claude` binary) on `PATH`
- Claude Max subscription (the orchestrator inherits `~/.claude/` credentials and unsets `ANTHROPIC_API_KEY` so subprocesses never silently fall back to API billing)
- Windows, macOS, or Linux

## Anthropic Terms of Service

Agent Harness invokes only the official `claude` binary as a subprocess. It
never reads `~/.claude/credentials`, never extracts subscription OAuth tokens,
never calls `api.anthropic.com` endpoints directly, and actively unsets
`ANTHROPIC_API_KEY` before each spawn so subscription auth is the only path.

Subscriptions (Claude Pro / Max) are designed for personal use of the official
Claude products including Claude Code and its plugin/subagent system. Using
this plugin to run intensive headless workflows on a subscription account is
your responsibility under Anthropic's ToS. Balanced defaults
(`maxParallel=2`, `budgetMinutes=120`, `interTaskPacingMs=5000`,
`autoResumeRateLimit=false`) keep the traffic profile in line with intensive
human use rather than automated bulk usage. For commercial automation, set
`HARNESS_AUTH_MODE=api` and provide your own `ANTHROPIC_API_KEY` (paid per
token).

Two compliance test files (`tests/compliance/`) statically verify these
architectural commitments on every CI run. See
[docs/anthropic-compliance.md](./docs/anthropic-compliance.md) for the full
architectural rationale.

## Install

There are two supported paths.

### As a Claude Code plugin (preferred)

```sh
claude plugin marketplace add "C:\Users\dev\Agent Harness"
claude plugin install agent-harness@local
claude /harness-dashboard
```

The `/harness-dashboard` command runs the launcher script for your platform (`scripts/launch-dashboard.ps1` on Windows, `scripts/launch-dashboard.sh` on POSIX), picks a free port in `4400-4500`, writes connection state to `${CLAUDE_PLUGIN_DATA}/state.json`, and opens the dashboard in your default browser.

### From source (developer mode)

```sh
pnpm install
pnpm build
HARNESS_SERVE_WEB=1 node apps/dashboard-server/dist/server.js
# then open http://127.0.0.1:4400
```

With `HARNESS_SERVE_WEB=1` the dashboard server static-serves the built `apps/dashboard-web/dist/` from `/`, so a single port hosts UI + API + WS. To develop against a hot-reloading frontend instead, leave `HARNESS_SERVE_WEB` unset and run the Vite dev server in a second terminal:

```sh
pnpm --filter @agent-harness/dashboard-web dev
```

The Vite dev server runs at `http://localhost:5173` and proxies API/WS calls to the backend on `127.0.0.1:4400`.

## Quickstart

1. **Create a project.** Open the dashboard, click "New project" in the sidebar, and fill in name, goal, and `repoPath`. The repo path must point at an existing git-initialized directory; the orchestrator creates per-task worktrees inside it.

   _TODO: GIF/screenshot here_

2. **Configure the team.** The TeamBuilder shows three role cards (architect, developer, QA). Defaults are sensible: opus for architect and planner, sonnet for developer and QA. Edit the `model`, `allowedTools`, and `systemPrompt` per role if you need to.

   _TODO: GIF/screenshot here_

3. **Generate, review, run.** Hit "Generate plan" — the planner agent emits a DAG which renders in the PlanEditor (React Flow + dagre). Click any node to edit its prompt, dependencies, success criteria, or `maxTurns` in the side panel. When the plan looks right, click "Lock & Run". The RunView opens; the kanban fills as tasks transition.

   _TODO: GIF/screenshot here_

## Architecture

A single Fastify + WebSocket process owns SQLite, dispatches `claude -p` subprocesses through a `SubprocessPool`, and fans events out to a React dashboard. See [docs/architecture.md](docs/architecture.md) for the full breakdown.

```
+--------------------+        HTTP + WS         +-------------------+
|   dashboard-web    | <----------------------> |  dashboard-server |
|  (React + Vite)    |                          |     (Fastify)     |
+--------------------+                          +---------+---------+
                                                          |
                                          +---------------+---------------+
                                          |                               |
                                  +-------v-------+              +--------v-------+
                                  |   Drizzle +   |              |   RunRuntime   |
                                  |   SQLite      |              |   + Walker     |
                                  +---------------+              +--------+-------+
                                                                          |
                                                            +-------------+-------------+
                                                            | SubprocessPool            |
                                                            | (claude -p in worktrees)  |
                                                            +---------------------------+
```

## Configuration

The dashboard server reads its configuration from environment variables (parsed in [`apps/dashboard-server/src/env.ts`](apps/dashboard-server/src/env.ts)):

| Var                   | Default                                                   | Purpose                                                                       |
| --------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `HARNESS_PORT`        | `4400`                                                    | TCP port for HTTP + WS server                                                 |
| `HARNESS_HOST`        | `127.0.0.1`                                               | Bind address                                                                  |
| `HARNESS_DATA_DIR`    | `os.tmpdir()/agent-harness` (dev); required in production | Holds SQLite DB, snapshots, worktrees                                         |
| `HARNESS_LOG_LEVEL`   | `info`                                                    | pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`) |
| `HARNESS_CORS_ORIGIN` | `http://localhost:5173`                                   | Vite dev origin allowed by `@fastify/cors`                                    |
| `HARNESS_MOCK_CLI`    | `false`                                                   | Use mock fixtures instead of real `claude` (for tests)                        |
| `HARNESS_SERVE_WEB`   | `false`                                                   | Static-serve `apps/dashboard-web/dist/` from `/` (single-port UI + API + WS)  |

Notes:

- Setting `NODE_ENV=production` makes `HARNESS_DATA_DIR` mandatory and disables the pretty pino transport.
- `HARNESS_SERVE_WEB` requires that `apps/dashboard-web/dist/` exists. Run `pnpm build` first (or omit the flag and use the Vite dev server during development).

## Development

Common scripts (run from the repo root):

```sh
pnpm dev          # all packages, parallel watch
pnpm build        # tsc -b across all packages
pnpm test         # vitest in each package
pnpm typecheck    # tsc -b --pretty
pnpm lint         # eslint .
pnpm format       # prettier --write
pnpm format:check # prettier --check
```

### Drizzle migrations

The dashboard-server owns the SQLite schema. To add a migration:

```sh
pnpm --filter @agent-harness/dashboard-server db:generate
pnpm --filter @agent-harness/dashboard-server db:migrate
```

Migrations run automatically on server boot via [`apps/dashboard-server/src/db/migrate.ts`](apps/dashboard-server/src/db/migrate.ts).

### Mock CLI mode

Setting `HARNESS_MOCK_CLI=1` swaps the real `claude` binary for a deterministic fixture, used by integration tests in [`packages/orchestrator/src/__tests__`](packages/orchestrator/src/__tests__) and [`apps/dashboard-server/src/__tests__`](apps/dashboard-server/src/__tests__). See [docs/development.md](docs/development.md) for how to write a new mock mode.

### End-to-end smoke test

A Playwright harness lives in [`tests/e2e/`](tests/e2e). One-time browser bundle download, then build + run:

```sh
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

The harness boots the dashboard with `HARNESS_SERVE_WEB=1` + `HARNESS_MOCK_CLI=1` on port 4499, drives the UI through the create-project → save-team → generate-plan → lock-and-run path, and asserts the run completes. See [tests/e2e/README.md](tests/e2e/README.md) for full details.

## Roadmap

- **M2 — variable team builder.** Lift the fixed 3-role team to an arbitrary number of roles with explicit dependency edges between specs. Per-role model overrides, custom tool grants.
- **M3 — shared-memory MCP.** A small MCP server that sits between subprocesses and shares a structured memory layer (architecture decisions, file ownership, prior verdicts) across agents in the same run.
- **M4 — team-template marketplace.** Distributable team templates (architect + N developers + QA + reviewer + ...) discoverable via the Claude Code plugin marketplace.
- **M5 — QA replan loop.** When QA returns FAIL repeatedly, hand the verdicts back to the planner to surgically rewrite the affected slice of the DAG, instead of just retrying the developer node.

## License

UNLICENSED — proprietary while the API stabilizes. The repository structure is open-source-ready; the license will be revisited at M3.

## Repo layout

```
.
├── .claude-plugin/        # plugin.json + marketplace.json
├── agents/                # architect, developer, qa, planner agent specs
├── apps/
│   ├── dashboard-server/  # Fastify + Drizzle + WS, owns SQLite + Walker runtime
│   └── dashboard-web/     # Vite + React + Tailwind + shadcn dashboard
├── commands/              # /harness-dashboard slash-command
├── docs/                  # architecture, agents, development reference
├── hooks/                 # PreCompact + SessionStart hook config
├── packages/
│   ├── orchestrator/      # subprocess + pool + walker + worktree + verification
│   └── schemas/           # Drizzle DB schema + Zod plan/event/team schemas
├── scripts/               # dashboard launcher (PowerShell + bash)
├── tests/
│   └── e2e/               # Playwright end-to-end harness
├── CHANGELOG.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Further reading

- [docs/architecture.md](docs/architecture.md) — components, data flow, state machines, resilience matrix.
- [docs/agents.md](docs/agents.md) — role/model/tool contract for each agent.
- [docs/development.md](docs/development.md) — onboarding, gotchas, mock CLI, WS debugging.
- [CHANGELOG.md](CHANGELOG.md) — what shipped in M1.
