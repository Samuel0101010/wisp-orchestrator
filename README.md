<p align="center">
  <img src="docs/assets/wisp-logo.png" alt="WISP" width="320">
</p>

<p align="center">
  <img src="docs/assets/wisp-figure.png" alt="Wisp — Agent Harness mascot" width="240">
</p>

Visual team-builder, plan-as-artifact, and live execution graph for autonomous Claude Code agent crews. Spawn a 3-role team, generate a DAG plan, run for hours, watch it ship in your browser.

## What it is

The agent ecosystem today fragments across three categories that do not compose: chat UIs that run a single agent at a time; orchestrators that hide the plan as opaque internal state; and notebooks that demand babysitting. Nothing combines an editable team specification, a plan you can inspect and edit before it runs, and a live execution graph that survives across rate-limit windows and machine restarts.

Agent Harness is a local-first orchestrator for Claude Code that delivers exactly that vertical slice. You describe a goal, configure a team of 1–8 roles (architect, developers, QA, reviewers — whatever your workflow needs), optionally seed it from a built-in template, generate a plan as a directed acyclic graph, optionally edit it, then lock and run. A `Walker` dispatches tasks via `claude -p` subprocesses pinned to per-task git worktrees, parses streamed events, and persists everything to SQLite. Tasks share state via a per-run memory MCP. When QA fails terminally, the planner is invoked again with the QA error context and the run continues on a corrected plan. The browser dashboard renders the live state: a kanban board, a streaming text tail, a resource-budget meter, a rate-limit countdown that survives server restarts, and a plan-version badge for replanned runs.

## Status

**v1.0 — personal-use complete.** All M1–M5 milestones plus plugin Skills are merged. The harness can drive a full architect → dev → qa cycle against real Claude Max, with variable team sizes, shared memory across tasks, built-in templates, automatic QA-replan, and slash-command workflows that let you run the harness without leaving Claude Code.

### What's new in v1.0

- **Variable team (M2).** Roles are a `{roles: AgentSpec[]}` array (1..8 roles, kebab-case unique names, model enum opus/sonnet/haiku). Planner, walker, and TeamBuilder UI are all role-list-driven.
- **Shared-memory MCP (M3).** `@agent-harness/memory-mcp` is a stdio MCP server that exposes `memory.{set,get,list,delete}` to every task subprocess. The architect can drop notes; the developer reads them. Per-run SQLite isolation under `<HARNESS_DATA_DIR>/memory/<runId>.db`. See [docs/memory-mcp.md](docs/memory-mcp.md).
- **Team templates (M4).** Four built-in templates (`ts-library`, `python-backend`, `refactor-squad`, `data-pipeline`) plus user-saved templates under `<HARNESS_DATA_DIR>/templates/`. Picker in the New Project dialog; "Save as Template" on TeamBuilder. See [docs/templates.md](docs/templates.md).
- **QA-driven replan (M5).** When QA fails terminally, the walker calls a server helper that composes a new prompt with the QA error context, generates a fresh plan, and continues the run. Capped at 1 replan per run. Audit trail via `parent_plan_id`. Visible in the UI as a "v2 (replanned)" badge. See [docs/replan.md](docs/replan.md).
- **Plugin Skills.** Four `/harness-*` slash commands so the dashboard is optional: `/harness-new-run` (goal → running execution), `/harness-resume` (paused runs), `/harness-inspect` (result branch + git log), `/harness-diagnose` (event timeline).
- **Foundation hardening from M1.5/Stage 1.** `harness.verify-failed` events with full payload, retry-prompt size cap, `successCriteria.preflight` (one-time setup before build/test/lint), `task.usage` parser fixed for the modern result-frame, `CI=true` + `npm_config_os/arch` injected into verify subprocesses for cross-platform pnpm install.

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
claude plugin marketplace add Samuel0101010/agent-harness
claude plugin install agent-harness@agent-harness-local
claude /harness-dashboard
```

(For local development, replace the first line with `claude plugin marketplace add /absolute/path/to/agent-harness`.)

The `/harness-dashboard` command runs the launcher script for your platform (`scripts/launch-dashboard.ps1` on Windows, `scripts/launch-dashboard.sh` on POSIX). On the **first** invocation after a fresh install, the launcher auto-runs `pnpm install && pnpm build` (~1-2 minutes — pnpm must be on PATH). On subsequent invocations it boots straight to the server. Either way it picks a free port in `4400-4500`, writes connection state to `${CLAUDE_PLUGIN_DATA}/state.json`, and opens the dashboard in your default browser.

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

## Runtime verification (v1.8)

The harness now insists on **proving** an app runs before declaring it done, instead of trusting `build + test` green as a finish line.

- **Definition-of-Done card** on the project detail page lets you declare per-project acceptance criteria. Three kinds: `smoke` (HTTP probe of a URL), `e2e` (a Playwright-driven user action — the verifier writes the actual test from your one-line description), `manual` (human sign-off — never auto-passes; blocks auto-release until the approver clears it).
- **runtime-verifier agent** is auto-injected behind every terminal node of every new plan. It starts your dev server, drives Chromium against your DoD, writes `docs/runtime-report.{md,json}`, and stores screenshots / traces under `docs/runtime-evidence/`.
- **Release-gate** turns the verifier's verdict into one of READY / BLOCKED / MANUAL-REVIEW. BLOCKED runs are held back from auto-merge and feed their failing gates into the next self-healing iteration. Visible on the RunView as a verdict pill + Boot / E2E / DoD count badges.
- **Playwright auto-install.** First runtime-verify in a fresh install downloads Chromium once into `~/.cache/agent-harness/playwright-browsers`. Subsequent runs are instant — every worktree shares the cache via `PLAYWRIGHT_BROWSERS_PATH`.
- **`pnpm doctor`** — runs a quick check that Node, pnpm, `claude`, git, and the Playwright cache are all reachable. Diagnostic only; exits 0. Prints the exact one-liner to populate anything missing.

The whole layer is opt-in per project (`runtimeVerifyEnabled` defaults to ON; flip it off on the Production-Modus card to fall back to v1.7 behaviour). Plans created before v1.8 keep running with their old shape — the verifier only gets injected into newly-generated plans.

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

| Var                              | Default                                                   | Purpose                                                                                                                |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_PORT`                   | `4400`                                                    | TCP port for HTTP + WS server                                                                                          |
| `HARNESS_HOST`                   | `127.0.0.1`                                               | Bind address                                                                                                           |
| `HARNESS_DATA_DIR`               | `os.tmpdir()/agent-harness` (dev); required in production | Holds SQLite DB, snapshots, worktrees                                                                                  |
| `HARNESS_LOG_LEVEL`              | `info`                                                    | pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`)                                          |
| `HARNESS_CORS_ORIGIN`            | `http://localhost:5173`                                   | Vite dev origin allowed by `@fastify/cors`                                                                             |
| `HARNESS_MOCK_CLI`               | `false`                                                   | Use mock fixtures instead of real `claude` (for tests)                                                                 |
| `HARNESS_SERVE_WEB`              | `false`                                                   | Static-serve `apps/dashboard-web/dist/` from `/` (single-port UI + API + WS)                                           |
| `HARNESS_INTER_TASK_PACING_MS`   | `5000`                                                    | Wallclock pause between consecutive task dispatches (subscription-friendly)                                            |
| `HARNESS_AUTO_RESUME_RATE_LIMIT` | `false`                                                   | When true, the walker auto-resumes a rate-limit pause at `resumeAt`. Off keeps the run paused for the user to inspect. |
| `HARNESS_AUTH_MODE`              | `subscription`                                            | `subscription` (default) or `api`. Toggles the auth-probe path; subprocesses always inherit `~/.claude/` credentials.  |

Notes:

- Setting `NODE_ENV=production` makes `HARNESS_DATA_DIR` mandatory and disables the pretty pino transport.
- `HARNESS_SERVE_WEB` requires that `apps/dashboard-web/dist/` exists. Run `pnpm build` first (or omit the flag and use the Vite dev server during development).

## Claude Code Hooks (optional)

The harness can capture telemetry from Claude Code sessions running inside this
repo via the bundled `.claude/settings.json`. To enable:

1. Pick a random shared secret and set it in `.env.local`:
   ```bash
   echo "HARNESS_HOOK_TOKEN=$(openssl rand -hex 16)" >> .env.local
   ```
2. Make sure the dashboard-server is running (`pnpm --filter dashboard-server dev`).
3. Open Claude Code in this repo. The hooks at `.claude/hooks/handler.cjs` will
   POST events to `http://127.0.0.1:4400/api/hooks/event` and you'll see them at
   `GET /api/hooks/events`.

Without `HARNESS_HOOK_TOKEN`, the handler exits silently and the server returns
503 — hooks are off by default and never block Claude Code.

## Development

Common scripts (run from the repo root):

```sh
pnpm dev             # all packages, parallel watch
pnpm build           # tsc -b across all packages
pnpm test            # unit tests only (e2e excluded — use test:e2e for those)
pnpm test:e2e        # Playwright smoke + a11y + i18n + tooltips + wave3
pnpm typecheck       # tsc -b --pretty
pnpm lint            # eslint .
pnpm format          # prettier --write
pnpm format:check    # prettier --check
pnpm encoding:check  # mojibake guardrail (UTF-8 double-encoding)
```

### Running the dashboard locally (Windows note)

The `pnpm dev` parallel wrapper does not stream backend logs cleanly on Windows
(`tsx watch` swallows stdout in some shell configurations). For interactive
work prefer the two-terminal split, and detach the backend process from the
parent shell when running long sessions so it survives a parent reap:

```pwsh
# Terminal A — backend (detached so it survives the parent PowerShell session)
Start-Process -NoNewWindow pnpm -ArgumentList 'exec','tsx','apps/dashboard-server/src/server.ts'

# Terminal B — frontend (HMR)
pnpm --filter dashboard-web exec vite
```

```sh
# POSIX equivalent
nohup pnpm exec tsx apps/dashboard-server/src/server.ts > harness.log 2>&1 &
pnpm --filter dashboard-web exec vite
```

The backend prints `server ready` on stdout (or in `harness.log`) when it's
listening on `:4400`; wait for that before opening `http://localhost:5173`. If
a long verification pass kills both processes with exit 127, it's almost
always the parent shell being reaped — re-run with `Start-Process`/`nohup` as
above rather than diagnosing further.

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

v1.0 is **personal-use complete.** Open work past v1.0 is out of scope for this repo (the plan was always to ship the personal-use slice and stop).

Possible future directions, deliberately not pursued in v1.0:

- Anthropic-marketplace publication (kept private).
- Multi-tenant deployment (SQLite + per-machine paths assume one user).
- Direct-API mode beyond the existing `HARNESS_AUTH_MODE=api` stub.
- `(plan_id, task_id)` composite key in the `tasks` table so each replan version's per-task token totals are recorded independently. Today the events table is the audit source for replanned runs.

## License

Apache-2.0 — see [LICENSE](LICENSE). Repository is private at the moment; the license declaration takes effect whenever the repo (or the plugin via marketplace) becomes public.

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
│   ├── memory-mcp/        # M3 — stdio MCP server for shared per-run kv store
│   └── schemas/           # Drizzle DB schema + Zod plan/event/team schemas
├── skills/                # M6 — /harness-new-run, -resume, -inspect, -diagnose
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
