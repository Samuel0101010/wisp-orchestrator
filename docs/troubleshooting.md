# Troubleshooting

Common problems encountered while installing or operating WISP, with symptom — root cause — fix triplets. If you hit something not covered here, check [CONTRIBUTING.md](../CONTRIBUTING.md) before filing a bug report.

This guide assumes a working knowledge of the [Quickstart](../README.md#quickstart) and the environment matrix in [Configuration](../README.md#configuration).

---

## Problem: `claude plugin marketplace add` fails with `Permission denied (publickey)`

**Symptom**

```
git@github.com: Permission denied (publickey).
fatal: Could not read from remote repository.
```

The very first install command (`claude plugin marketplace add Samuel0101010/wisp-orchestrator`) aborts before the plugin is ever registered.

**Cause**

`plugin marketplace add owner/repo` clones over SSH by default. On a machine with no GitHub SSH key configured, that clone fails — even though `wisp-orchestrator` is a **public** repo that needs no authentication over HTTPS.

**Fix**

Tell git to rewrite GitHub SSH URLs to HTTPS once, then re-run the command:

```sh
git config --global "url.https://github.com/.insteadOf" "git@github.com:"
```

In PowerShell, keep the space between the two quoted arguments. The setting is global and harmless — it only changes how `github.com` remotes are resolved.

---

## Problem: `claude` CLI not found on PATH

**Symptom**

```
command not found: claude
# or on Windows
'claude' is not recognized as an internal or external command
```

Server boot may also print an `auth-probe` event with `ok: false` and a hint pointing back at the missing binary.

**Cause**

WISP shells out to the official `claude` binary for every agent task. If the CLI is not installed, or is installed in a directory that is not on `PATH`, every subprocess spawn fails immediately.

**Fix**

1. Install Claude Code from <https://claude.ai/code>.
2. Restart your shell so the new entry is picked up.
3. Verify:
   ```sh
   # POSIX
   which claude

   # Windows (PowerShell)
   Get-Command claude
   ```
4. Re-run `pnpm doctor` (from a source checkout) — it checks `claude`, `node`, `pnpm`, and the Playwright browser cache in one pass.

---

## Problem: Port 4400 already in use

**Symptom**

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:4400
```

WISP exits during `main()` before the dashboard is reachable.

**Cause**

A previous dashboard-server process is still holding the port. This is common after a hard kill (Ctrl+C in a parent shell that did not propagate SIGTERM) or when two launchers race.

**Fix**

Find and kill the owning process, then restart:

```pwsh
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 4400 | Select-Object OwningProcess
Stop-Process -Id <PID>
```

```sh
# macOS / Linux
lsof -ti:4400 | xargs kill -9
```

Or pick a different port. The `/wisp-dashboard` launcher already auto-selects a
free port in the 4400–4500 range, so this only bites a manual boot — set the
port explicitly there:

```sh
WISP_PORT=4401 pnpm dev          # from a source checkout
```

`WISP_HOST` and `WISP_PORT` are both honoured by `apps/dashboard-server/src/env.ts`.

---

## Problem: `pnpm install` hangs or fails with lockfile mismatch

**Symptom**

```
ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date
```

Or `pnpm install` stalls for many minutes during the resolution phase.

**Cause**

Three usual suspects:

1. The active pnpm version is older than the one the lockfile was produced with.
2. A stale `node_modules` from a previous Node major still ships native bindings that fail to load.
3. A transient network problem against the npm registry.

**Fix**

```sh
pnpm --version
# Must be >= 9. If not:
corepack enable
corepack prepare pnpm@latest --activate
```

Then nuke and reinstall:

```sh
# POSIX
rm -rf node_modules
pnpm install --frozen-lockfile
```

```pwsh
# Windows
Remove-Item -Recurse -Force node_modules
pnpm install --frozen-lockfile
```

If the failure is in `better-sqlite3`'s postinstall, also run `pnpm approve-builds` — see the [development guide](development.md#better-sqlite3-native-build).

---

## Problem: Build fails with `TS2307: Cannot find module '@wisp/...'`

**Symptom**

```
src/foo.ts:1:23 - error TS2307: Cannot find module '@wisp/orchestrator' or its corresponding type declarations.
```

Typecheck fails even though `pnpm install` succeeded.

**Cause**

Workspace packages publish from `dist/`. The `exports` field in their `package.json` resolves to compiled output, so any consumer (`apps/dashboard-server`, `apps/dashboard-web`) cannot find the types until the producers have been built at least once.

**Fix**

Build shared packages first, then run typecheck:

```sh
pnpm -r --filter "./packages/**" run build
pnpm typecheck
```

CI does this automatically. Local gates may not — wire the two commands together in any pre-push hook you maintain.

---

## Problem: `git worktree add` fails with "already exists"

**Symptom**

```
fatal: '<repo>/../worktrees/<task-id>' already exists
```

or the orchestrator emits `addWorktree: exhausted retries without resolution`.

**Cause**

The Walker creates one git worktree per task under `<repoPath>/../worktrees/`. A hard kill of the server (SIGKILL, OOM, power loss) can leave the directory on disk while the corresponding `tasks` row has already been freed. The next attempt to create a worktree at the same name collides.

**Fix**

```sh
git worktree list
git worktree remove <path-from-list>
```

For mass cleanup of orphans:

```sh
git worktree prune
```

The bundled `SessionStart` hook (`scripts/session-start-cleanup.sh`) runs this automatically when you reopen Claude Code in the repo.

---

## Problem: Agent runs forever / appears stuck

**Symptom**

A task row stays in `running` state long past its expected duration. The kanban does not advance, no new events arrive on the WS.

**Cause**

Since v1.7.12 every task subprocess has an inactivity watchdog. If it does not kill the agent, the most common stuck pattern is an agent awaiting a prompt response that will never come — for example a tool call that triggered a confirmation prompt outside the streaming protocol.

**Fix**

1. Open the dashboard, go to the **Workers** tab, click **Stop run**. This pauses the walker and persists a checkpoint so you can resume after diagnosis.
2. Inspect the per-agent session log at `<repoPath>/.wisp/logs/<runId>/<agent>.log` for the last lines emitted before the stall.
3. Check the **Chat** tab for any pending prompts that need a human reply.
4. If the stall is reproducible, lower `maxTurns` on that task in the PlanEditor before re-running.

---

## Problem: `Anthropic 529 Overloaded` errors

**Symptom**

Task events with `type: "error"` and a payload mentioning `529`, `overloaded_error`, or `Anthropic capacity`.

**Cause**

Anthropic API capacity throttling. These are usually transient and last seconds to a few minutes.

**Fix**

Since v1.7.10 the resolver and main task subprocess auto-retry transient 529s with backoff (see release notes for v1.7.10–v1.7.12). For runs that still fail after the built-in retries:

- Use the dashboard's **Pause** / **Resume** controls — the walker resumes from the last checkpoint.
- Switch the affected role to a different model in TeamBuilder (`opus` ↔ `sonnet`) and re-run; capacity issues are rarely symmetric across model tiers.
- If the issue is sustained, check <https://status.anthropic.com/> before continuing to retry.

---

## Problem: API mode — missing `ANTHROPIC_API_KEY`

**Symptom**

Server boots, but every agent task fails immediately with an auth-related error. The boot `auth-probe` event prints `ok: false` with a hint about credentials.

**Cause**

`WISP_AUTH_MODE=api` was set in the environment, but no `ANTHROPIC_API_KEY` is exported. WISP only strips `ANTHROPIC_API_KEY` from subprocess env when it is in subscription mode; in API mode it is **required**.

**Fix**

Either provide the key:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
# then relaunch: /wisp-dashboard  (or `pnpm dev` from a source checkout)
```

Or fall back to subscription mode (the default):

```sh
unset WISP_AUTH_MODE
# then relaunch: /wisp-dashboard  (or `pnpm dev` from a source checkout)
```

See [anthropic-compliance.md](anthropic-compliance.md) for the full auth-mode contract.

---

## Problem: Database is locked / `SQLITE_BUSY`

**Symptom**

```
SqliteError: database is locked
```

surfaced from a route handler or from the migrate step at boot.

**Cause**

Two SQLite writers contending for the same DB file. In WISP v2.0+ the dashboard-server sets a `busy_timeout` and serializes writers internally, so this should not happen during normal use. It does happen when:

- Two `dashboard-server` processes target the same `WISP_DATA_DIR` simultaneously.
- A previous run was force-killed while writing, leaving a `*.db-journal` or `*.db-wal` sidecar that the kernel still has a handle on.

**Fix**

1. Stop **all** WISP processes:
   ```pwsh
   Get-Process -Name node | Where-Object { $_.Path -match 'dashboard-server' } | Stop-Process
   ```
2. Remove stale sidecars from `${WISP_DATA_DIR}`:
   ```sh
   rm -f "$WISP_DATA_DIR"/harness.db-journal "$WISP_DATA_DIR"/harness.db-wal "$WISP_DATA_DIR"/harness.db-shm
   ```
3. Restart with a single server process.

If the issue persists after a clean restart, file a bug — it is a regression.

---

## Problem: Dashboard shows old version after upgrade

**Symptom**

You bumped to a newer WISP release, but the dashboard still shows the previous build hash in the footer or the previous shape of a page.

**Cause**

Either browser cache (most common), or you are still running the previous server binary.

**Fix**

1. Hard-refresh the page (`Ctrl+Shift+R` on Windows/Linux, `Cmd+Shift+R` on macOS). Or open DevTools → Network tab → tick **Disable cache** and reload.
2. Confirm the server you are talking to is the new one:
   ```sh
   # POSIX
   ps aux | grep dashboard-server | grep -v grep

   # Windows
   Get-Process node | Where-Object { $_.CommandLine -match 'dashboard-server' }
   ```
3. If the old PID is still around, kill it and re-launch via `/wisp-dashboard` (or `pnpm dev` from source).

---

## Problem: Mojibake / wrong characters in agent output

**Symptom**

UTF-8 text in plans, prompts, or generated files shows up as `Ã¤`, `â€"`, or other doubly-encoded sequences. CI may fail with a guardrail message from `pnpm encoding:check`.

**Cause**

A file was saved as Windows-1252 / latin-1 and later read as UTF-8, or written through a stream that double-encoded it. The most common trigger is a subagent edit that round-trips text through a non-UTF-8 codec without the editor preserving the encoding.

**Fix**

```sh
pnpm encoding:check
```

For any file the check flags, re-save it as **UTF-8 without BOM** in your editor (VS Code: `Save with Encoding → UTF-8`). Then re-run the check until it is green.

---

## Problem: Tests pass locally but fail in CI

**Symptom**

`pnpm test` and `pnpm typecheck` are green on your machine, but the GitHub Actions run fails on the same SHA — often on `TS2307` or a missing built artifact.

**Cause**

CI builds shared packages before running typecheck/test; local gates often do not. Cached `dist/` directories from a previous local build hide the missing build step.

**Fix**

Run the same sequence CI runs:

```sh
pnpm install --frozen-lockfile
pnpm -r --filter "./packages/**" run build
pnpm typecheck
pnpm test
```

If that fails locally, you have reproduced the CI failure and can debug. If it passes locally but still fails in CI, compare Node + pnpm versions — CI pins them, your shell may not.

---

## Problem: Plugin not appearing in Claude Code after install

**Symptom**

`claude plugin install wisp@wisp-local` succeeds but `/wisp-dashboard` is not offered, or `claude plugin list` does not show WISP.

**Cause**

Claude Code caches the plugin manifest on startup. A plugin installed mid-session is not visible until the next restart. After editing `marketplace.json` you also have to re-add the marketplace.

**Fix**

```sh
claude restart
claude plugin list
```

If WISP is missing, re-register the marketplace and re-install:

```sh
claude plugin marketplace add Samuel0101010/wisp-orchestrator
claude plugin install wisp@wisp-local
```

For a local checkout, replace the GitHub coordinate with the absolute path to your clone.

---

## Problem: Where do I find the logs?

There are three layers, each useful for a different question.

| Layer            | Path                                                       | What you find there                                |
| ---------------- | ---------------------------------------------------------- | -------------------------------------------------- |
| Server logs      | stdout of the dashboard-server process (`/wisp-dashboard` launcher or `pnpm dev`), or `${WISP_DATA_DIR}/logs/server.log` | Boot, route errors, walker lifecycle, auth probe   |
| Per-agent logs   | `<repoPath>/.wisp/logs/<runId>/<agent>.log`                | Full NDJSON event stream from each `claude -p`     |
| Dashboard console| Browser DevTools → Console                                 | Client-side errors, WS connection issues           |

Set `WISP_LOG_LEVEL=debug` on the server for verbose route + WS tracing. Persisted events for a run can also be pulled straight out of SQLite — see the [debugging notes in development.md](development.md#debugging) for the exact query.

---

## Still stuck?

- For reproducible bugs, file an issue per the instructions in [CONTRIBUTING.md](../CONTRIBUTING.md). Include the relevant lines from the three log layers above and the output of `pnpm doctor`.
- For security-sensitive reports (credential leakage, sandbox escape, unauthorized network egress), use the disclosure channel in [SECURITY.md](../SECURITY.md) — **do not** open a public issue.
