# @wisp/e2e — Playwright end-to-end smoke tests

This package hosts the Phase F1 end-to-end smoke test. It boots the dashboard
in **mock-CLI mode** (no real `claude` subprocess), serves the UI from the
dashboard-server (`WISP_SERVE_WEB=1`) on a single port, and drives the
full happy-path through the React UI:

```
create project → save team → generate plan → lock & run → wait for done
```

The mock CLI fixture lives at
`packages/orchestrator/tests/fixtures/mock-claude.mjs`. The server picks the
right `MOCK_MODE` per call:

- planner calls (taskId prefixed with `planner-`) → `MOCK_MODE=plan`,
  writes a valid 3-node DAG plan.json then exits 0
- task calls (architect/developer/qa) → `MOCK_MODE=task`, emits a few
  text-deltas + a usage event, exits 0

Verification commands in the generated plan are `{custom: 'true'}`, so each
task's gate runs the shell builtin `true` and passes.

## One-time setup

```bash
pnpm install
pnpm exec playwright install chromium
```

`playwright install` downloads the Chromium browser bundle (~200 MB), so this
step is intentionally not part of the default verify pipeline.

## Run the suite

The dashboard must be built first — the test boots `apps/dashboard-server/dist/server.js`
and serves `apps/dashboard-web/dist/`:

```bash
pnpm build
pnpm test:e2e
```

Or directly via the workspace filter:

```bash
pnpm --filter @wisp/e2e test
```

Or from inside this directory:

```bash
cd tests/e2e
pnpm exec playwright test
```

> Note: invoking via `pnpm exec playwright test --config tests/e2e/playwright.config.ts`
> from the repo root currently fails with a "two versions of @playwright/test"
> error due to pnpm's flat hoisting at the root. Use one of the three commands
> above instead.

Other useful invocations (run from `tests/e2e/`):

```bash
# List the tests without running them (no chromium needed):
pnpm exec playwright test --list

# Watch the browser as the test runs:
pnpm exec playwright test --headed

# Open the trace UI after a failure:
pnpm exec playwright show-report
```

## What the suite does

- `globalSetup` (`global-setup.ts`):
  - Verifies `apps/dashboard-server/dist/server.js` and `apps/dashboard-web/dist/index.html` exist.
  - Creates an isolated tmp `WISP_DATA_DIR`.
  - Initializes a tmp git repo with one initial commit so `git worktree add` succeeds.
- `webServer` (`playwright.config.ts`):
  - Spawns `node apps/dashboard-server/dist/server.js` on port 4499.
  - Sets `WISP_MOCK_CLI=1`, `WISP_SERVE_WEB=1`, points `WISP_DATA_DIR` at the tmp dir.
  - Waits on `/api/health` to return 200.
- `smoke.spec.ts`: drives the UI through the full happy path and asserts:
  - The UI lands on `/projects/<id>` (Brief tab) after project creation; the spec then opens the `/projects/<id>/teams` Team Builder route.
  - The plan editor renders with 3 nodes (architect/developer/qa).
  - The run page shows all three task cards in the `Done` kanban column.
  - The run badge reads `completed` / `done` / `success`.

## Determinism notes

- `workers: 1`, `fullyParallel: false`. The dashboard-server holds a single sqlite
  DB; running multiple suites in parallel against the same data dir would cause
  flake.
- Local dev runs with `retries: 1` to absorb transient flake (e.g. WS reconnects).
  CI runs with `retries: 0` so failures fail loud.
