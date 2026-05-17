# Uninstalling WISP

A clean removal in five steps. Skip what does not apply to your install.

## 1. Stop the server

Find and kill the running dashboard-server process:

- **Windows (PowerShell):**
  ```powershell
  Get-Process node | Where-Object { $_.Path -like '*dashboard-server*' }
  Stop-Process -Id <PID>
  ```
- **Unix:**
  ```sh
  ps aux | grep dashboard-server
  kill <PID>
  ```

If the server is running in a foreground terminal (e.g. you started it via
`/wisp-dashboard` or `pnpm dev`), just `Ctrl+C` in that terminal.

## 2. Uninstall the plugin

```sh
claude plugin uninstall wisp
claude plugin marketplace remove Samuel0101010/wisp-orchestrator
```

(If you installed from a local marketplace path during development, pass that
path to `marketplace remove` instead of the GitHub slug.)

## 3. Remove local data (optional)

WISP stores all state under `WISP_DATA_DIR`. The **default** is
`os.tmpdir()/wisp` (e.g. `/tmp/wisp` on Unix, `%TEMP%\wisp` on Windows). If you
set `WISP_DATA_DIR` to a custom path, use that instead. Contents include:

- `data.db` — SQLite database with project / run / agent history
- `memory/<runId>.db` — per-run shared-memory MCP stores
- `templates/` — user-saved team templates
- `logs/` — server + agent logs
- `worktrees/` — temporary git worktrees

To wipe everything:

- **Unix:** `rm -rf "$(node -e 'console.log(require("os").tmpdir())')/wisp"`
  (or `rm -rf "$WISP_DATA_DIR"` if you set one)
- **Windows (PowerShell):** `Remove-Item -Recurse -Force "$env:TEMP\wisp"`
  (or `Remove-Item -Recurse -Force $env:WISP_DATA_DIR` if you set one)

## 4. Remove cloned-source installation (only if you installed from source)

If you cloned the repo for local development, drop the working copy:

```sh
rm -rf /path/to/wisp-orchestrator/
```

Nothing else is installed globally — no system services, no daemons, no
registry keys.

## 5. Revoke API keys (if applicable)

If you used `WISP_AUTH_MODE=api` and want to revoke the key you provisioned,
visit <https://console.anthropic.com/settings/keys> and delete it. Subscription
mode does not provision any keys — your `claude login` session is untouched
by uninstall.
