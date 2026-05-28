---
name: wisp-dashboard
description: Open the WISP dashboard in your browser
allowed-tools: Bash(powershell *), Bash(bash *)
---

Launch the WISP dashboard server (if not already running) and open it in your default browser. The launcher picks a free port in the 4400-4500 range, writes connection state to `${CLAUDE_PLUGIN_DATA}/state.json`, and prints the URL.

**First-launch:** the launcher auto-runs `pnpm install && pnpm build` (~1-2 minutes one-time). Requires **Node >= 20.10**; the launcher uses `pnpm` if on PATH, otherwise falls back to `corepack` (bundled with Node >= 16.13). On Windows, native module compilation needs Visual Studio Build Tools (C++ workload). On macOS, Xcode Command Line Tools (`xcode-select --install`). On Linux, `build-essential` + `python3`.

Pick the script for the user's OS — only one of these runs:

**Windows (PowerShell):**

```bash
powershell -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/launch-dashboard.ps1"
```

**macOS/Linux (bash):**

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/launch-dashboard.sh"
```
