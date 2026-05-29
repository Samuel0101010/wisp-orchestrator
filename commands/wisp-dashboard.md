---
name: wisp-dashboard
description: Open the WISP dashboard in your browser
allowed-tools: Bash(powershell *), Bash(bash *)
---

Launch the WISP dashboard server (if not already running) and open it in your default browser. The launcher picks a free port in the 4400-4500 range, writes its connection state + log paths into its data dir, and prints the URL. Re-running is safe: if a server is already live it just re-opens the browser instead of spawning a second one.

**First-launch:** the launcher auto-runs `pnpm install && pnpm build` (~1-2 minutes one-time). Requires **Node >= 20.10** — **Node 22 LTS or Node 24 LTS recommended**, because a prebuilt `better-sqlite3` binary ships for them and no C++ compiler is needed. The launcher uses `pnpm` if on PATH, otherwise falls back to `corepack` (bundled with Node). Native compilation only kicks in on an untested Node (no prebuilt); that needs Windows → Visual Studio Build Tools (C++ workload), macOS → `xcode-select --install`, Linux → `build-essential` + `python3`. On a build failure the launcher prints the log path and a targeted hint.

**For live runs** (spawning agents), the standalone **`claude` CLI must be on PATH** — this is separate from the Claude Code desktop app. The dashboard still boots without it; `/api/health` simply surfaces an auth hint.

**Choose the launcher by OS — run exactly ONE block.** On **Windows**, run ONLY the PowerShell block. On **macOS/Linux**, run ONLY the bash block. Never run the bash launcher on Windows.

**Windows (PowerShell):**

```bash
powershell -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/launch-dashboard.ps1"
```

**macOS/Linux (bash):**

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/launch-dashboard.sh"
```
